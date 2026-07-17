"""Tests for `core.battle_report`: `SessionRecord` bookkeeping plus
`BattleReportGenerator`/`BattleReportManager` rendering.

Migrated from ``nekro_trpg_dice_plugin``'s ``tests/test_core_fixes.py``:
- `test_session_record_tracks_critical_failure_separately`
- `test_battle_report_preserves_custom_session_name_after_end` (now driven by
  `infra.store.Store` instead of the nekro-local `FakeStore`)

Plus new coverage requested for the M0 port: a full `SessionRecord`
`to_dict`/`from_dict` round trip, and the `generate_battle_report` return
tuple shape (including the "no active session" edge case).
"""

import json

from core.battle_report import BattleReportGenerator, BattleReportManager, SessionRecord
from infra.i18n import I18n
from infra.store import Store

# ---------------------------------------------------------------------------
# SessionRecord — pure bookkeeping (migrated + round-trip)
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


def test_add_skill_check_detects_success_in_english_and_chinese_labels():
    record = SessionRecord("session-checks")

    record.add_skill_check("u1", "Alice", "Listen", 50, 30, "Hard Success")
    record.add_skill_check("u1", "Alice", "Spot Hidden", 60, 80, "failure")
    record.add_skill_check("u1", "Alice", "Library Use", 70, 5, "成功")

    stats = record.player_stats["u1"]
    assert stats["total_checks"] == 3
    assert stats["successful_checks"] == 2


def test_add_skill_check_counts_structured_hard_and_extreme_successes():
    record = SessionRecord("session-structured-checks")

    record.add_skill_check("u1", "Alice", "Listen", 50, 20, success=True, rank=2)
    record.add_skill_check("u1", "Alice", "Spot Hidden", 60, 5, success=True, rank=3)

    assert record.player_stats["u1"]["successful_checks"] == 2
    assert record.skill_checks[0]["success"] is True
    assert record.skill_checks[0]["rank"] == 2
    assert "success_level" not in record.skill_checks[0]


def test_structured_skill_check_rank_is_localized_only_when_rendered():
    generator = BattleReportGenerator(Store())
    record = SessionRecord("session-rank-render")
    record.add_skill_check("u1", "Alice", "Listen", 50, 20, success=True, rank=2)

    en = generator.generate_markdown_report(record, "Rank", i18n=I18n(locale="en"), detailed=True)
    zh = generator.generate_markdown_report(record, "等级", i18n=I18n(locale="zh"), detailed=True)

    assert "Hard Success" in en
    assert "困难成功" in zh


def test_legacy_stored_hard_success_is_recounted_case_insensitively():
    restored = SessionRecord.from_dict(
        {
            "session_id": "legacy",
            "start_time": 1.0,
            "skill_checks": [
                {
                    "user_id": "u1",
                    "char_name": "Alice",
                    "skill": "Listen",
                    "target": 50,
                    "roll": 20,
                    "success_level": "Hard Success",
                    "timestamp": 2.0,
                }
            ],
            "player_stats": {"u1": {"char_name": "Alice", "successful_checks": 0}},
        }
    )

    assert restored.player_stats["u1"]["successful_checks"] == 1


def test_add_key_event_and_add_player_action_update_stats():
    record = SessionRecord("session-events")

    record.add_key_event("The door creaks open", event_type="discovery")
    record.add_player_action("u1", "Alice", "searches the bookshelf")
    record.add_player_action("u1", "Alice", "lights a lantern")

    assert record.key_events[0]["description"] == "The door creaks open"
    assert record.key_events[0]["event_type"] == "discovery"
    assert record.player_stats["u1"]["action_count"] == 2


def test_get_duration_minutes_uses_end_time_once_ended():
    record = SessionRecord("session-duration")
    record.start_time = 1_000.0
    record.end_time = 1_000.0 + 90 * 60  # 90 minutes later

    assert record.get_duration_minutes() == 90


def test_session_record_full_round_trip_via_to_dict_from_dict():
    record = SessionRecord("session-rt")
    record.add_dice_roll("u1", "Alice", "1d20", 20, True, "success")
    record.add_dice_roll("u1", "Alice", "1d20", 1, True, "failure")
    record.add_skill_check("u1", "Alice", "Spot Hidden", 60, 45, "success")
    record.add_key_event("The door creaks open", event_type="discovery")
    record.add_player_action("u1", "Alice", "searches the bookshelf")
    record.combat_rounds.append({"round": 1, "notes": "ambush"})
    record.npc_interactions.append({"npc": "Innkeeper", "note": "gave a clue"})
    record.end_session()

    # Round-trip through actual JSON (as the store does), not just Python dicts.
    restored = SessionRecord.from_dict(json.loads(json.dumps(record.to_dict())))

    assert restored.to_dict() == record.to_dict()
    assert restored.session_id == record.session_id
    assert restored.start_time == record.start_time
    assert restored.end_time == record.end_time
    assert restored.dice_rolls == record.dice_rolls
    assert restored.skill_checks == record.skill_checks
    assert restored.combat_rounds == record.combat_rounds
    assert restored.key_events == record.key_events
    assert restored.npc_interactions == record.npc_interactions
    assert restored.player_actions == record.player_actions
    assert restored.player_stats == record.player_stats


def test_session_record_from_dict_tolerates_missing_optional_fields():
    """`from_dict` must not crash on a minimal payload (mirrors the source's `.get(..., default)` use)."""
    restored = SessionRecord.from_dict({"session_id": "sparse", "start_time": 123.0})

    assert restored.session_id == "sparse"
    assert restored.end_time is None
    assert restored.dice_rolls == []
    assert restored.skill_checks == []
    assert restored.combat_rounds == []
    assert restored.key_events == []
    assert restored.npc_interactions == []
    assert restored.player_actions == {}
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
    record = await manager.generator.get_current_session(chat_key)
    assert record is not None
    record.add_key_event("发现入口")
    await manager.generator.save_session(chat_key, record)

    _, _, session_name = await manager.generate_battle_report(chat_key)

    assert session_name == "深海古城"
    assert await store.get(store_key=f"session_name.{chat_key}.current") is None


async def test_generate_battle_report_returns_text_markdown_session_name_tuple():
    store = Store()
    manager = BattleReportManager(store)
    chat_key = "chat-shape"

    await manager.start_session(chat_key, "Tuple Shape Test")
    await manager.add_dice_roll(chat_key, "u1", "Bob", "1d20", 20, True, "success")
    await manager.add_skill_check(chat_key, "u1", "Bob", "Listen", 50, 30, "success")
    await manager.add_key_event(chat_key, "Found a clue")

    result = await manager.generate_battle_report(chat_key)

    assert isinstance(result, tuple)
    assert len(result) == 3
    text, markdown, session_name = result
    assert isinstance(text, str) and text
    assert isinstance(markdown, str) and markdown
    assert session_name == "Tuple Shape Test"
    assert "Bob" in text
    assert "Bob" in markdown


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
    await manager.add_key_event(chat_key, "Something happened")
    await manager.generate_battle_report(chat_key)

    history_raw = await store.get(store_key=f"session_history.{chat_key}.{session_id}")
    latest_raw = await store.get(store_key=f"session_history.{chat_key}.latest")
    latest_name = await store.get(store_key=f"session_name.{chat_key}.latest")

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


async def test_start_session_is_idempotent_and_preserves_existing_events():
    store = Store()
    manager = BattleReportManager(store)
    chat_key = "chat-idempotent"

    first_id = await manager.start_session(chat_key, "First")
    await manager.add_key_event(chat_key, "kept event")
    second_id = await manager.start_session(chat_key, "Second")

    record = await manager.generator.get_current_session(chat_key)
    assert record is not None
    assert second_id == first_id
    assert [event["description"] for event in record.key_events] == ["kept event"]
    assert await store.get(store_key=f"session_name.{chat_key}.current") == "First"


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
    await manager.add_key_event(chat_key, "archive me")
    new_id = await manager.start_session(chat_key, "New", force_new=True)

    assert new_id != old_id
    archived = await store.get(store_key=f"session_history.{chat_key}.{old_id}")
    assert archived is not None
    assert json.loads(archived)["key_events"][0]["description"] == "archive me"
    current = await manager.generator.get_current_session(chat_key)
    assert current is not None
    assert current.session_id == new_id
    assert current.key_events == []


def test_npc_rolls_and_checks_are_excluded_from_player_stats():
    record = SessionRecord("session-npc")

    record.add_dice_roll("__npc__", "Goblin", "1d20+3", 17)
    record.add_skill_check("__npc__", "Goblin", "Stealth", 12, 18, success=True, rank=1)

    assert len(record.dice_rolls) == 1
    assert len(record.skill_checks) == 1
    assert record.player_stats == {}
    detailed = BattleReportGenerator(Store()).generate_markdown_report(
        record, "NPC", i18n=I18n(locale="en"), detailed=True
    )
    assert "Goblin" in detailed


def test_key_event_deduplication_only_suppresses_recent_identical_text(monkeypatch):
    record = SessionRecord("session-dedupe")
    now = 10_000.0
    monkeypatch.setattr("core.battle_report.time.time", lambda: now)
    record.add_key_event("same event")
    record.add_key_event("same event")
    monkeypatch.setattr("core.battle_report.time.time", lambda: now + 301)
    record.add_key_event("same event")

    assert len(record.key_events) == 2


def test_report_recaps_sample_the_timeline_and_cap_rendered_text():
    generator = BattleReportGenerator(Store())
    record = SessionRecord("session-recap")
    for index in range(20):
        record.add_key_event(f"EVENT-{index:02d} " + ("x" * 240))

    markdown = generator.generate_markdown_report(record, "Recap", i18n=I18n(locale="en"))
    recap = markdown.split("Key Events Recap", 1)[1]

    assert "EVENT-00" in recap
    assert "EVENT-19" in recap
    assert "EVENT-01" not in recap
    assert "…" in recap
    assert "x" * 210 not in recap


def test_report_renders_transparent_score_breakdown_in_both_locales():
    generator = BattleReportGenerator(Store())
    record = SessionRecord("session-score-breakdown")
    record.add_dice_roll("u1", "Alice", "1d20", 12)
    record.add_skill_check("u1", "Alice", "Listen", 50, 20, success=True, rank=2)
    record.add_player_action("u1", "Alice", "listens at the door")

    en = generator.generate_markdown_report(record, "Score", i18n=I18n(locale="en"))
    zh = generator.generate_markdown_report(record, "评分", i18n=I18n(locale="zh"))

    assert "Score breakdown" in en
    assert "评分明细" in zh


def test_report_totals_distinguish_raw_rolls_from_checks_and_checks_count_for_participation():
    generator = BattleReportGenerator(Store())
    record = SessionRecord("session-check-only")
    record.add_skill_check("u1", "Alice", "Listen", 50, 20, success=True, rank=2)

    breakdown = generator.calculate_player_score_breakdown("u1", record)
    en = generator.generate_markdown_report(record, "Checks", i18n=I18n(locale="en"))
    zh = generator.generate_markdown_report(record, "检定", i18n=I18n(locale="zh"))

    assert breakdown["participation"] == 2
    assert "Raw Dice Rolls (non-checks) | 0" in en
    assert "Skill Checks | 1" in en
    assert "原始投骰记录（不含检定） | 0" in zh
    assert "技能检定次数 | 1" in zh


async def test_get_last_session_summary_none_without_history():
    store = Store()
    manager = BattleReportManager(store)

    assert await manager.get_last_session_summary("chat-no-history") is None


async def test_get_last_session_summary_reflects_last_archived_session():
    store = Store()
    manager = BattleReportManager(store)
    chat_key = "chat-summary"

    await manager.start_session(chat_key, "Prior Adventure")
    await manager.add_key_event(chat_key, "The party found the artifact")
    await manager.generate_battle_report(chat_key)

    summary = await manager.get_last_session_summary(chat_key)

    assert summary is not None
    assert "Prior Adventure" in summary
    assert "The party found the artifact" in summary


def test_calculate_player_score_reports_not_participated_for_unknown_user():
    store = Store()
    generator = BattleReportGenerator(store)
    record = SessionRecord("session-score")

    score, rating = generator.calculate_player_score("ghost", record)

    assert score == 0
    assert rating == "Did not participate"


def test_calculate_player_score_rewards_rolls_checks_actions_and_crits():
    store = Store()
    generator = BattleReportGenerator(store)
    record = SessionRecord("session-score-2")
    record.add_dice_roll("u1", "Alice", "1d20", 20, True, "success")
    record.add_skill_check("u1", "Alice", "Listen", 50, 10, "success")
    record.add_player_action("u1", "Alice", "investigates the desk")

    score, rating = generator.calculate_player_score("u1", record)

    assert score > 60  # base score plus bonuses
    assert isinstance(rating, str) and rating


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


def test_generate_report_text_and_markdown_differ_by_locale():
    store = Store()
    generator = BattleReportGenerator(store)
    record = SessionRecord("session-locale")
    record.add_key_event("A strange noise echoes")

    en_text = generator.generate_report_text(record, "Locale Test", i18n=I18n(locale="en"))
    zh_text = generator.generate_report_text(record, "Locale Test", i18n=I18n(locale="zh"))

    assert en_text != zh_text
    assert "Session Statistics" in en_text
    assert "游戏统计" in zh_text


# ---------------------------------------------------------------------------
# generate_markdown_report(detailed=...) — summary vs. full-transcript variants
# ---------------------------------------------------------------------------


def _detailed_record() -> SessionRecord:
    """A SessionRecord touching every transcript source: action, roll, skill check, key event."""
    record = SessionRecord("session-detailed")
    record.add_player_action("u1", "Alice", "pries open the rusted locker")
    record.add_dice_roll("u1", "Alice", "1d20", 15)  # non-critical: not a summary "highlight"
    record.add_skill_check("u1", "Alice", "Spot Hidden", 60, 42, "regular success")
    record.add_key_event("A hidden compartment clicks open", event_type="discovery")
    return record


def test_generate_markdown_report_summary_default_is_byte_compatible_and_omits_transcript():
    generator = BattleReportGenerator(Store())
    record = _detailed_record()
    i18n = I18n(locale="en")

    default = generator.generate_markdown_report(record, "Locker Room", i18n=i18n)
    explicit_summary = generator.generate_markdown_report(record, "Locker Room", i18n=i18n, detailed=False)

    # the default and detailed=False renderings are identical (backward compatible)
    assert default == explicit_summary
    # the per-event transcript is entirely absent from the summary
    assert "Full Session Log" not in default
    assert "pries open the rusted locker" not in default  # player-action text is transcript-only
    assert "Spot Hidden" not in default  # per-check skill name is transcript-only (summary is aggregate)


def test_generate_markdown_report_detailed_appends_full_transcript():
    generator = BattleReportGenerator(Store())
    record = _detailed_record()
    i18n = I18n(locale="en")

    summary = generator.generate_markdown_report(record, "Locker Room", i18n=i18n)
    detailed = generator.generate_markdown_report(record, "Locker Room", i18n=i18n, detailed=True)

    # detailed keeps the whole summary (both headings present) and is strictly longer
    assert "Player Scores" in detailed and "Session Statistics" in detailed
    assert len(detailed) > len(summary)

    # transcript heading + one line per recorded event
    assert "Full Session Log" in detailed
    assert "pries open the rusted locker" in detailed  # player action
    assert "1d20" in detailed and "15" in detailed  # dice roll (expression + result), though non-critical
    assert "Spot Hidden" in detailed and "regular success" in detailed  # skill check WITH its success level
    assert "A hidden compartment clicks open" in detailed  # key event


def test_generate_markdown_report_detailed_transcript_is_chronological():
    """Transcript lines appear in timestamp order across event types."""
    generator = BattleReportGenerator(Store())
    record = SessionRecord("session-order")
    record.add_player_action("u1", "Alice", "FIRST-ACTION")
    record.add_dice_roll("u1", "Alice", "1d6", 4)  # SECOND
    record.add_key_event("THIRD-EVENT")
    i18n = I18n(locale="en")

    detailed = generator.generate_markdown_report(record, "Order Test", i18n=i18n, detailed=True)

    log = detailed.split("Full Session Log", 1)[1]
    assert log.index("FIRST-ACTION") < log.index("1d6") < log.index("THIRD-EVENT")


def test_generate_markdown_report_detailed_localizes_transcript_heading():
    generator = BattleReportGenerator(Store())
    detailed_zh = generator.generate_markdown_report(
        _detailed_record(), "储物间", i18n=I18n(locale="zh"), detailed=True
    )

    assert "完整跑团记录" in detailed_zh  # localized transcript heading
    assert "储物间" in detailed_zh
    assert "Full Session Log" not in detailed_zh
