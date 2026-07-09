"""Tests for core.game_clock (pure, no i18n).

Advancing preserves the input's format family (a zh 年月日 clock stays zh, an
ISO clock stays ISO) and an unparseable side returns the clock text UNCHANGED —
the caller (`agent.kp_tools_knowledge.game_clock`) renders the localized notice.
"""

from core.game_clock import advance_game_time, parse_game_datetime, parse_time_delta


def test_advance_game_time_advances_chinese_hour_delta_keeping_zh_format():
    assert advance_game_time("1926年3月15日 14:00", "+2小时") == ("1926年03月15日 16:00", True)


def test_advance_game_time_keeps_iso_format_for_an_iso_clock():
    # The old behavior forced 年月日 onto every advanced clock, leaking CJK into
    # an English room's HUD the first time the KP advanced time.
    assert advance_game_time("1926-03-15 14:00", "+1day") == ("1926-03-16 14:00", True)
    assert advance_game_time("1928-10-17 21:40", "+15 minutes") == ("1928-10-17 21:55", True)


def test_advance_game_time_keeps_slash_format_and_promotes_date_only_to_datetime():
    assert advance_game_time("1926/03/15 14:00", "+2hours") == ("1926/03/15 16:00", True)
    assert advance_game_time("1926-03-15", "+2hours") == ("1926-03-15 02:00", True)
    assert advance_game_time("1926年3月15日", "+30分钟") == ("1926年03月15日 00:30", True)


def test_advance_game_time_returns_clock_unchanged_when_current_time_unparseable():
    assert advance_game_time("未设定", "+2小时") == ("未设定", False)
    assert advance_game_time("Day 3, evening", "+2 hours") == ("Day 3, evening", False)


def test_advance_game_time_returns_clock_unchanged_when_delta_unparseable():
    assert advance_game_time("1926-03-15 14:00", "过一会儿") == ("1926-03-15 14:00", False)


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
