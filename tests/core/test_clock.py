"""Tests for core.game_clock (ported verbatim from nekro - pure, no i18n).

Cases mirror `test_advance_game_time_parses_chinese_and_english_units_with_fallback`
in nekro `tests/test_core_fixes.py`. See docs/specs/M0.md §1.
"""

from core.game_clock import advance_game_time, parse_game_datetime, parse_time_delta


def test_advance_game_time_advances_chinese_hour_delta():
    assert advance_game_time("1926年3月15日 14:00", "+2小时") == ("1926年03月15日 16:00", True)


def test_advance_game_time_advances_english_day_delta():
    assert advance_game_time("1926-03-15 14:00", "+1day") == ("1926年03月16日 14:00", True)


def test_advance_game_time_falls_back_when_current_time_unparseable():
    assert advance_game_time("未设定", "+2小时") == ("未设定 → 推进 +2小时", False)


def test_advance_game_time_falls_back_when_delta_unparseable():
    assert advance_game_time("1926-03-15 14:00", "过一会儿") == ("1926-03-15 14:00 → 推进 过一会儿", False)


def test_parse_game_datetime_supports_multiple_formats():
    assert parse_game_datetime("1926-03-15") is not None
    assert parse_game_datetime("1926/03/15") is not None
    assert parse_game_datetime("1926年3月15日") is not None
    assert parse_game_datetime("not a date") is None


def test_parse_time_delta_supports_chinese_and_english_units():
    assert parse_time_delta("+30分钟").total_seconds() == 30 * 60
    assert parse_time_delta("-1小时").total_seconds() == -3600
    assert parse_time_delta("+2days").total_seconds() == 2 * 86400
    assert parse_time_delta("gibberish") is None
