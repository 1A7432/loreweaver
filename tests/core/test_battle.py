"""Tests for `core.battle_report`: `SessionRecord`'s two dice ledgers plus
`BattleReportGenerator`/`BattleReportManager` rendering.

Migrated from ``nekro_trpg_dice_plugin``'s ``tests/test_core_fixes.py``:
- `test_session_record_tracks_critical_failure_separately`
- `test_battle_report_preserves_custom_session_name_after_end` (now driven by
  `infra.store.Store` instead of the nekro-local `FakeStore`)

The report's NARRATIVE half is not recorded here at all — it is the room's own
`chat_history`, handed to `generate_markdown_report` as `transcript=`, so the
tests at the bottom feed it the wire shape `agent.history.load_chain` returns.
"""

import json

from core.battle_report import (
    TRANSCRIPT_MAX_CHARS,
    BattleReportGenerator,
    BattleReportManager,
    SessionRecord,
)
from infra.i18n import I18n
from infra.llm import HISTORY_TURN_KEY
from infra.store import Store

EN = I18n(locale="en")


def _message(role: str, content: str, turn: int = 1) -> dict:
    """One `agent.history.load_chain` record, in its wire shape."""
    return {"role": role, "content": content, HISTORY_TURN_KEY: turn}


# ---------------------------------------------------------------------------
# SessionRecord — the dice ledgers (migrated + round-trip)
# ---------------------------------------------------------------------------


def test_session_record_tracks_critical_failure_separately():
    """Migrated from nekro's `test_session_record_tracks_critical_failure_separately`."""
    record = SessionRecord("session-test")

    record.add_dice_roll("u1", "Alice", "1d20", 20, True, "success")
    record.add_dice_roll("u1", "Alice", "1d20", 1, True, "failure")

    stats = record.player_stats["u1"]
    assert stats["critical_success"] == 1
    assert stats["critical_failure"] == 1
    assert stats["total_rolls"] == 2


def test_add_dice_roll_legacy_is_critical_without_type_counts_as_success():
    """`is_critical=True` with no explicit `critical_type` is legacy shorthand for a success."""
    record = SessionRecord("session-legacy")

    record.add_dice_roll("u1", "Alice", "1d20", 20, is_critical=True)

    stats = record.player_stats["u1"]
    assert stats["critical_success"] == 1
    assert stats["critical_failure"] == 0


def test_add_dice_roll_non_critical_does_not_affect_critical_counters():
    record = SessionRecord("session-normal")

    record.add_dice_roll("u1", "Alice", "1d20", 10)

    stats = record.player_stats["u1"]
    assert stats["total_rolls"] == 1
    assert stats["critical_success"] == 0
    assert stats["critical_failure"] == 0


def test_add_skill_check_counts_semantic_success_flags():
    record = SessionRecord("session-checks")

    record.add_skill_check("u1", "Alice", "Listen", 50, 30, success=True, rank_id="hard", tier=3, label="Hard Success")
    record.add_skill_check("u1", "Alice", "Spot Hidden", 60, 80, success=False, rank_id="fail", tier=1, label="失败")
    record.add_skill_check("u1", "Alice", "Library Use", 70, 5, success=True, rank_id="extreme", tier=4, label="成功")

    stats = record.player_stats["u1"]
    assert stats["total_checks"] == 3
    assert stats["successful_checks"] == 2


def test_add_skill_check_counts_critical_and_fumble_separately():
    record = SessionRecord("session-structured-checks")

    record.add_skill_check("u1", "Alice", "Listen", 50, 1, success=True, rank_id="crit", tier=5, critical=True)
    record.add_skill_check("u1", "Alice", "Spot Hidden", 60, 100, success=False, rank_id="fumble", tier=0, fumble=True)

    stats = record.player_stats["u1"]
    assert stats["successful_checks"] == 1
    assert stats["critical_success"] == 1
    assert stats["critical_failure"] == 1
    assert record.skill_checks[0]["success"] is True
    assert record.skill_checks[0]["rank_id"] == "crit"
    assert "success_level" not in record.skill_checks[0]


def test_skill_check_label_is_recorded_verbatim_and_rendered_in_the_dice_log():
    generator = BattleReportGenerator(Store())
    record = SessionRecord("session-rank-render")
    record.add_skill_check("u1", "Alice", "Listen", 50, 20, success=True, rank_id="hard", tier=3, label="困难成功")

    full = generator.generate_markdown_report(record, "Rank", i18n=EN, transcript=[])

    # A historical record replays the label it was recorded with, verbatim.
    assert "困难成功" in full


def test_restored_record_recounts_structured_success_flags():
    restored = SessionRecord.from_dict(
        {
            "session_id": "restored",
            "start_time": 1.0,
            "skill_checks": [
                {
                    "user_id": "u1",
                    "char_name": "Alice",
                    "skill": "Listen",
                    "target": 50,
                    "roll": 20,
                    "success": True,
                    "rank_id": "hard",
                    "tier": 3,
                    "timestamp": 2.0,
                }
            ],
            "player_stats": {"u1": {"char_name": "Alice", "successful_checks": 0}},
        }
    )

    assert restored.player_stats["u1"]["successful_checks"] == 1


def test_get_duration_minutes_uses_end_time_once_ended():
    record = SessionRecord("session-duration")
    record.start_time = 1_000.0
    record.end_time = 1_000.0 + 90 * 60  # 90 minutes later

    assert record.get_duration_minutes() == 90


def test_session_record_full_round_trip_via_to_dict_from_dict():
    record = SessionRecord("session-rt")
    record.add_dice_roll("u1", "Alice", "1d20", 20, True, "success")
    record.add_dice_roll("u1", "Alice", "1d20", 1, True, "failure")
    record.add_skill_check("u1", "Alice", "Spot Hidden", 60, 45, success=True, rank_id="regular", tier=2)
    record.end_session()

    # Round-trip through actual JSON (as the store does), not just Python dicts.
    restored = SessionRecord.from_dict(json.loads(json.dumps(record.to_dict())))

    assert restored.to_dict() == record.to_dict()
    assert restored.session_id == record.session_id
    assert restored.start_time == record.start_time
    assert restored.end_time == record.end_time
    assert restored.dice_rolls == record.dice_rolls
    assert restored.skill_checks == record.skill_checks
    assert restored.player_stats == record.player_stats


def test_session_record_from_dict_tolerates_missing_optional_fields():
    """`from_dict` must not crash on a minimal payload (mirrors the source's `.get(..., default)` use)."""
    restored = SessionRecord.from_dict({"session_id": "sparse", "start_time": 123.0})

    assert restored.session_id == "sparse"
    assert restored.end_time is None
    assert restored.dice_rolls == []
    assert restored.skill_checks == []
    assert restored.player_stats == {}


# ---------------------------------------------------------------------------
# BattleReportManager / BattleReportGenerator — store-backed behavior
# ---------------------------------------------------------------------------


async def test_battle_report_preserves_custom_session_name_after_end():
    """Migrated from nekro's `test_battle_report_preserves_custom_session_name_after_end`."""
    store = Store()
    manager = BattleReportManager(store)
    chat_key = "chat-a"

    await manager.start_session(chat_key, "深海古城")
    await manager.add_dice_roll(chat_key, "u1", "调查员", "1d100", 42)

    _, _, session_name = await manager.generate_battle_report(chat_key)

    assert session_name == "深海古城"
    assert await store.get(store_key=f"session_name.{chat_key}.current") is None


async def test_generate_battle_report_returns_text_markdown_session_name_tuple():
    store = Store()
    manager = BattleReportManager(store)
    chat_key = "chat-shape"

    await manager.start_session(chat_key, "Tuple Shape Test")
    await manager.add_dice_roll(chat_key, "u1", "Bob", "1d20", 20, True, "success")
    await manager.add_skill_check(chat_key, "u1", "Bob", "Listen", 50, 30, success=True, rank_id="regular", tier=2)

    result = await manager.generate_battle_report(chat_key)

    assert isinstance(result, tuple)
    assert len(result) == 3
    text, markdown, session_name = result
    assert isinstance(text, str) and text
    assert isinstance(markdown, str) and markdown
    assert session_name == "Tuple Shape Test"
    assert "Bob" in text
    assert "Bob" in markdown


async def test_generate_battle_report_carries_the_transcript_into_markdown_only():
    """The Markdown file is the players' keepsake; the text report is the scoreboard
    the model reads back, so a 100-turn transcript must never land in it."""
    store = Store()
    manager = BattleReportManager(store)
    chat_key = "chat-transcript-split"
    await manager.start_session(chat_key, "Split")
    await manager.add_dice_roll(chat_key, "u1", "Bob", "1d20", 11)

    text, markdown, _ = await manager.generate_battle_report(
        chat_key,
        transcript=[_message("user", "I knock twice."), _message("assistant", "The door opens inward.")],
    )

    assert "I knock twice." in markdown
    assert "The door opens inward." in markdown
    assert "I knock twice." not in text


async def test_generate_battle_report_returns_all_none_when_no_session():
    store = Store()
    manager = BattleReportManager(store)

    result = await manager.generate_battle_report("chat-empty")

    assert result == (None, None, None)


async def test_generate_battle_report_clears_current_session_record():
    store = Store()
    manager = BattleReportManager(store)
    chat_key = "chat-clear"

    await manager.start_session(chat_key)
    await manager.generate_battle_report(chat_key)

    assert await manager.generator.get_current_session(chat_key) is None
    assert await store.get(store_key=f"session_record.{chat_key}.current") is None


async def test_generate_battle_report_writes_session_history_store_keys():
    store = Store()
    manager = BattleReportManager(store)
    chat_key = "chat-history"

    session_id = await manager.start_session(chat_key, "History Keys Test")
    await manager.add_dice_roll(chat_key, "u1", "Alice", "1d6", 3)
    await manager.generate_battle_report(chat_key)

    history_raw = await store.state_get(chat_key, f"session_history.{session_id}")
    latest_raw = await store.state_get(chat_key, "session_history.latest")
    latest_name = await store.state_get(chat_key, "session_name.latest")

    assert history_raw is not None
    assert latest_raw == history_raw
    assert json.loads(history_raw)["session_id"] == session_id
    assert latest_name == "History Keys Test"


async def test_default_session_name_used_when_none_supplied():
    store = Store()
    manager = BattleReportManager(store)
    chat_key = "chat-default-name"

    await manager.start_session(chat_key)
    _, _, session_name = await manager.generate_battle_report(chat_key)

    assert session_name is not None
    assert session_name.startswith("Session-")  # default locale is "en"


async def test_ensure_session_started_auto_starts_only_once():
    store = Store()
    manager = BattleReportManager(store)
    chat_key = "chat-ensure"

    started_first = await manager.ensure_session_started(chat_key)
    started_second = await manager.ensure_session_started(chat_key)

    assert started_first is True
    assert started_second is False


async def test_start_session_is_idempotent_and_preserves_recorded_dice():
    store = Store()
    manager = BattleReportManager(store)
    chat_key = "chat-idempotent"

    first_id = await manager.start_session(chat_key, "First")
    await manager.add_dice_roll(chat_key, "u1", "Alice", "1d8", 5)
    second_id = await manager.start_session(chat_key, "Second")

    record = await manager.generator.get_current_session(chat_key)
    assert record is not None
    assert second_id == first_id
    assert [roll["expression"] for roll in record.dice_rolls] == ["1d8"]
    assert await store.state_get(chat_key, "session_name.current") == "First"


async def test_add_methods_auto_start_a_session_when_none_exists():
    manager = BattleReportManager(Store())
    chat_key = "chat-lazy-start"

    await manager.add_dice_roll(chat_key, "u1", "Alice", "1d6", 4)

    record = await manager.generator.get_current_session(chat_key)
    assert record is not None
    assert record.dice_rolls[0]["result"] == 4


async def test_force_new_archives_active_session_before_starting_fresh():
    store = Store()
    manager = BattleReportManager(store)
    chat_key = "chat-force-new"

    old_id = await manager.start_session(chat_key, "Old")
    await manager.add_dice_roll(chat_key, "u1", "Alice", "1d4", 2)
    new_id = await manager.start_session(chat_key, "New", force_new=True)

    assert new_id != old_id
    archived = await store.state_get(chat_key, f"session_history.{old_id}")
    assert archived is not None
    assert json.loads(archived)["dice_rolls"][0]["expression"] == "1d4"
    current = await manager.generator.get_current_session(chat_key)
    assert current is not None
    assert current.session_id == new_id
    assert current.dice_rolls == []


def test_npc_rolls_and_checks_are_excluded_from_player_stats():
    record = SessionRecord("session-npc")

    record.add_dice_roll("__npc__", "Goblin", "1d20+3", 17)
    record.add_skill_check("__npc__", "Goblin", "Stealth", 12, 18, success=True, rank=1)

    assert len(record.dice_rolls) == 1
    assert len(record.skill_checks) == 1
    assert record.player_stats == {}
    full = BattleReportGenerator(Store()).generate_markdown_report(record, "NPC", i18n=EN, transcript=[])
    assert "Goblin" in full


def test_report_renders_transparent_score_breakdown_in_both_locales():
    generator = BattleReportGenerator(Store())
    record = SessionRecord("session-score-breakdown")
    record.add_dice_roll("u1", "Alice", "1d20", 12)
    record.add_skill_check("u1", "Alice", "Listen", 50, 20, success=True, rank=2)

    en = generator.generate_markdown_report(record, "Score", i18n=EN)
    zh = generator.generate_markdown_report(record, "评分", i18n=I18n(locale="zh"))

    assert "Score breakdown" in en
    assert "评分明细" in zh


def test_report_totals_distinguish_raw_rolls_from_checks_and_checks_count_for_participation():
    generator = BattleReportGenerator(Store())
    record = SessionRecord("session-check-only")
    record.add_skill_check("u1", "Alice", "Listen", 50, 20, success=True, rank=2)

    breakdown = generator.calculate_player_score_breakdown("u1", record)
    en = generator.generate_markdown_report(record, "Checks", i18n=EN)
    zh = generator.generate_markdown_report(record, "检定", i18n=I18n(locale="zh"))

    assert breakdown["participation"] == 2
    assert "Raw Dice Rolls (non-checks) | 0" in en
    assert "Skill Checks | 1" in en
    assert "原始投骰记录（不含检定） | 0" in zh
    assert "技能检定次数 | 1" in zh


def test_calculate_player_score_reports_not_participated_for_unknown_user():
    store = Store()
    generator = BattleReportGenerator(store)
    record = SessionRecord("session-score")

    score, rating = generator.calculate_player_score("ghost", record)

    assert score == 0
    assert rating == "Did not participate"


def test_calculate_player_score_rewards_rolls_checks_and_crits():
    store = Store()
    generator = BattleReportGenerator(store)
    record = SessionRecord("session-score-2")
    record.add_dice_roll("u1", "Alice", "1d20", 20, True, "success")
    record.add_skill_check("u1", "Alice", "Listen", 50, 10, success=True, rank_id="hard", tier=3)

    score, rating = generator.calculate_player_score("u1", record)

    assert score > 60  # base score plus bonuses
    assert isinstance(rating, str) and rating


def test_the_score_has_no_roleplay_component_to_derive():
    """Roleplay is unscored on purpose: the transcript IS the record of it, and
    `chat_history` carries no speaker identity to attribute a line with."""
    generator = BattleReportGenerator(Store())
    record = SessionRecord("session-score-components")
    record.add_dice_roll("u1", "Alice", "1d20", 12)

    breakdown = generator.calculate_player_score_breakdown("u1", record)

    assert set(breakdown) == {"base", "participation", "success", "critical", "total"}


# ---------------------------------------------------------------------------
# i18n wiring — report text renders per-locale via infra.i18n
# ---------------------------------------------------------------------------


async def test_generate_battle_report_defaults_to_english_locale_text():
    store = Store()
    manager = BattleReportManager(store)
    chat_key = "chat-en"

    await manager.start_session(chat_key, "English Locale Test")
    text, markdown, _ = await manager.generate_battle_report(chat_key)

    assert "TRPG Session Battle Report" in text
    assert "Player Scores" in text
    assert "TRPG Session Battle Report" in markdown


async def test_generate_battle_report_zh_locale_matches_legacy_chinese_wording():
    """Explicit zh locale reproduces the original nekro Chinese report wording verbatim."""
    store = Store()
    manager = BattleReportManager(store)
    chat_key = "chat-zh"
    zh = I18n(locale="zh")

    await manager.start_session(chat_key, "深海古城", i18n=zh)
    await manager.add_dice_roll(chat_key, "u1", "调查员", "1d100", 1, True, "success")
    text, markdown, session_name = await manager.generate_battle_report(chat_key, i18n=zh)

    assert session_name == "深海古城"
    assert "TRPG 跑团战报" in text
    assert "玩家评分" in text
    assert "大成功" in text
    assert "TRPG 跑团战报" in markdown


def test_generate_report_text_differs_by_locale():
    store = Store()
    generator = BattleReportGenerator(store)
    record = SessionRecord("session-locale")
    record.add_dice_roll("u1", "Alice", "1d20", 9)

    en_text = generator.generate_report_text(record, "Locale Test", i18n=EN)
    zh_text = generator.generate_report_text(record, "Locale Test", i18n=I18n(locale="zh"))

    assert en_text != zh_text
    assert "Session Statistics" in en_text
    assert "游戏统计" in zh_text


# ---------------------------------------------------------------------------
# The transcript — the report's narrative half, rendered from `chat_history`
# ---------------------------------------------------------------------------


def _played_record() -> SessionRecord:
    record = SessionRecord("session-played")
    record.add_dice_roll("u1", "Alice", "1d20", 15)  # non-critical: not a summary "highlight"
    record.add_skill_check(
        "u1", "Alice", "Spot Hidden", 60, 42, success=True, rank_id="regular", tier=2, label="regular success"
    )
    return record


def _exchange() -> list[dict]:
    return [
        _message("user", "I pry open the rusted locker.", turn=1),
        _message("assistant", "The lid gives, and a hidden compartment clicks open.", turn=1),
    ]


def test_a_report_with_no_transcript_is_the_scoreboard_alone():
    generator = BattleReportGenerator(Store())
    record = _played_record()

    default = generator.generate_markdown_report(record, "Locker Room", i18n=EN)
    explicit = generator.generate_markdown_report(record, "Locker Room", i18n=EN, transcript=None)

    assert default == explicit
    assert "The Whole Session" not in default
    assert "Dice Log" not in default
    assert "Spot Hidden" not in default  # per-check values ride the full report


def test_the_full_report_carries_the_conversation_and_the_dice_values():
    generator = BattleReportGenerator(Store())
    record = _played_record()

    summary = generator.generate_markdown_report(record, "Locker Room", i18n=EN)
    full = generator.generate_markdown_report(record, "Locker Room", i18n=EN, transcript=_exchange())

    # the full report keeps the whole scoreboard and is strictly longer
    assert "Player Scores" in full and "Session Statistics" in full
    assert len(full) > len(summary)

    # ...the real exchange, both halves, verbatim...
    assert "I pry open the rusted locker." in full
    assert "The lid gives, and a hidden compartment clicks open." in full
    # ...each attributed and stamped with its turn...
    assert "[Turn 1] Player" in full
    assert "[Turn 1] Keeper" in full
    # ...and the dice values the prose does not carry.
    assert "1d20" in full and "15" in full
    assert "Spot Hidden" in full and "regular success" in full


def test_the_transcript_keeps_the_conversation_in_order():
    generator = BattleReportGenerator(Store())
    transcript = [
        _message("user", "FIRST-PLAYER-LINE", turn=1),
        _message("assistant", "SECOND-KEEPER-LINE", turn=1),
        _message("user", "THIRD-PLAYER-LINE", turn=2),
    ]

    full = generator.generate_markdown_report(SessionRecord("order"), "Order", i18n=EN, transcript=transcript)

    log = full.split("The Whole Session", 1)[1]
    assert log.index("FIRST-PLAYER-LINE") < log.index("SECOND-KEEPER-LINE") < log.index("THIRD-PLAYER-LINE")


def test_an_empty_transcript_still_renders_the_section_and_says_so():
    generator = BattleReportGenerator(Store())

    full = generator.generate_markdown_report(SessionRecord("fresh"), "Fresh", i18n=EN, transcript=[])

    assert "The Whole Session" in full
    assert "no conversation yet" in full


def test_an_oversized_transcript_keeps_the_recent_end_and_states_what_it_dropped():
    """Completeness beats brevity, but not without a bound: past the cap the report
    keeps the MOST RECENT messages — a session's ending is what a keepsake is for —
    and says how many it left out rather than truncating silently."""
    generator = BattleReportGenerator(Store())
    block = "y" * 4_000
    transcript = [_message("assistant", f"MESSAGE-{index:03d} {block}", turn=index) for index in range(120)]

    full = generator.generate_markdown_report(SessionRecord("long"), "Long", i18n=EN, transcript=transcript)

    log = full.split("The Whole Session", 1)[1]
    assert len(log) < TRANSCRIPT_MAX_CHARS + 10_000
    assert "MESSAGE-119" in log, "the newest message is always kept"
    assert "MESSAGE-000" not in log, "the oldest fell outside the cap"
    assert "earlier messages were left out" in log
    # What survives is a CONTIGUOUS tail — a hole in the middle would misread as
    # "these turns did not happen".
    kept = [index for index in range(120) if f"MESSAGE-{index:03d}" in log]
    assert kept == list(range(kept[0], 120))


def test_the_transcript_heading_and_speakers_are_localized():
    generator = BattleReportGenerator(Store())

    zh = generator.generate_markdown_report(
        _played_record(), "储物间", i18n=I18n(locale="zh"), transcript=_exchange()
    )

    assert "全程记录" in zh
    assert "守密人" in zh and "玩家" in zh
    assert "储物间" in zh
    assert "The Whole Session" not in zh
