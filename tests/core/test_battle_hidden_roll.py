"""Regression tests for the hidden-roll (`.rh`) leak fix in `core.battle_report`.

A hidden roll is recorded for the keeper's own bookkeeping, but MUST never
surface in any player-facing report: not in the detailed transcript, not in the
statistics/aggregate counts, and not in the critical-moment highlights. Before
the fix, `.report detailed` replayed every recorded roll (including hidden ones)
and counted them in the stats. These assertions fail on that old behavior.
"""

from core.battle_report import BattleReportGenerator, BattleReportManager, SessionRecord
from infra.i18n import I18n
from infra.store import Store


def _record_with_hidden() -> SessionRecord:
    record = SessionRecord("session-hidden")
    # One public roll and one HIDDEN critical-success roll for the same player.
    record.add_dice_roll("u1", "Nora", "1d20", 15)
    record.add_dice_roll("u1", "Nora", "1d100", 3, is_critical=True, critical_type="success", hidden=True)
    return record


def test_hidden_roll_excluded_from_player_aggregates():
    record = _record_with_hidden()
    stats = record.player_stats["u1"]
    # Only the public roll counts; the hidden critical does not inflate totals.
    assert stats["total_rolls"] == 1
    assert stats.get("critical_success", 0) == 0


def test_hidden_roll_survives_rebuild_but_stays_out_of_aggregates():
    record = _record_with_hidden()
    # rebuild_player_stats runs on load (from_dict); the hidden roll must still be
    # skipped there, else a reloaded session would leak it into the counts.
    round_trip = SessionRecord.from_dict(record.to_dict())
    assert any(roll.get("hidden") for roll in round_trip.dice_rolls)
    assert round_trip.player_stats["u1"]["total_rolls"] == 1
    assert round_trip.player_stats["u1"].get("critical_success", 0) == 0


def test_detailed_report_omits_hidden_roll_transcript_stats_and_highlights():
    record = _record_with_hidden()
    generator = BattleReportGenerator(Store())
    i18n = I18n(locale="en")

    detailed = generator.generate_markdown_report(record, "Hidden", i18n=i18n, detailed=True)
    plain = generator.generate_report_text(record, "Hidden", i18n=i18n)

    # The hidden roll's expression never appears; the public one does.
    assert "1d100" not in detailed
    assert "1d20" in detailed
    assert "1d100" not in plain
    # A hidden critical must not be promoted into the highlights section.
    assert i18n.t("battle.report.highlights_heading") not in detailed


def test_visible_roll_count_reported_is_one():
    """The rendered 'total dice rolls' statistic reflects only visible rolls."""
    record = _record_with_hidden()
    generator = BattleReportGenerator(Store())
    i18n = I18n(locale="en")
    text = generator.generate_report_text(record, "Counts", i18n=i18n)
    # The label line for total dice rolls must show 1, not 2.
    label = i18n.t("battle.report.label.total_dice_rolls")
    line = next(row for row in text.splitlines() if label in row)
    assert "1" in line and "2" not in line


async def test_manager_hidden_roll_persists_flag_and_stays_out_of_report():
    store = Store()
    manager = BattleReportManager(store)
    chat_key = "cli:dm:hidden"
    await manager.start_session(chat_key, "Manager Hidden")
    await manager.add_dice_roll(chat_key, "u1", "Nora", "1d20", 12)
    await manager.add_dice_roll(chat_key, "u1", "Nora", "1d100", 4, hidden=True)

    record = await manager.generator.get_current_session(chat_key)
    assert record is not None
    assert any(roll.get("hidden") for roll in record.dice_rolls)
    assert record.player_stats["u1"]["total_rolls"] == 1

    md = manager.generator.generate_markdown_report(record, "Manager Hidden", i18n=I18n(locale="en"), detailed=True)
    assert "1d100" not in md
    assert "1d20" in md
