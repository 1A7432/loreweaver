"""Pure helpers for game clock time advancement."""

import re
from datetime import datetime, timedelta

# Accepted input format -> the same-family output format used after advancing.
# Advancing preserves the style the table already uses (a zh 年月日 clock stays
# zh, an ISO clock stays ISO) instead of forcing one culture's format on every
# room; date-only inputs gain a time-of-day so sub-day deltas stay visible.
_TIME_FORMATS = {
    "%Y年%m月%d日 %H:%M": "%Y年%m月%d日 %H:%M",
    "%Y年%m月%d日%H:%M": "%Y年%m月%d日 %H:%M",
    "%Y-%m-%d %H:%M": "%Y-%m-%d %H:%M",
    "%Y/%m/%d %H:%M": "%Y/%m/%d %H:%M",
    "%Y-%m-%dT%H:%M": "%Y-%m-%d %H:%M",
    "%Y年%m月%d日": "%Y年%m月%d日 %H:%M",
    "%Y-%m-%d": "%Y-%m-%d %H:%M",
    "%Y/%m/%d": "%Y/%m/%d %H:%M",
}

_UNIT_SECONDS = {
    "分钟": 60,
    "分": 60,
    "min": 60,
    "mins": 60,
    "minute": 60,
    "minutes": 60,
    "小时": 3600,
    "时": 3600,
    "hour": 3600,
    "hours": 3600,
    "hr": 3600,
    "hrs": 3600,
    "天": 86400,
    "日": 86400,
    "day": 86400,
    "days": 86400,
    "d": 86400,
}


def _parse_with_format(value: str) -> tuple[datetime | None, str | None]:
    text = value.strip()
    for fmt in _TIME_FORMATS:
        try:
            return datetime.strptime(text, fmt), fmt
        except ValueError:
            continue
    return None, None


def parse_game_datetime(value: str) -> datetime | None:
    """Parse common Chinese/ISO-like game datetime strings."""
    return _parse_with_format(value)[0]


def parse_time_delta(value: str) -> timedelta | None:
    """Parse +N分钟/+N小时/+N天 and common English unit deltas."""
    text = value.strip().lower().replace(" ", "")
    match = re.fullmatch(r"([+-]?\d+)(分钟|分|min|mins|minute|minutes|小时|时|hour|hours|hr|hrs|天|日|day|days|d)", text)
    if not match:
        return None
    amount = int(match.group(1))
    unit = match.group(2)
    return timedelta(seconds=amount * _UNIT_SECONDS[unit])


def advance_game_time(current_time: str, delta_text: str) -> tuple[str, bool]:
    """Advance parseable game time, keeping the input's format family.

    Returns ``(new_time, True)`` on success. When either side is unparseable the
    clock text is returned UNCHANGED with ``False`` — the caller decides how to
    surface that (this is a pure core helper, so no user-facing language here).
    """
    current_dt, fmt = _parse_with_format(current_time)
    delta = parse_time_delta(delta_text)
    if current_dt and delta and fmt:
        advanced = current_dt + delta
        return advanced.strftime(_TIME_FORMATS[fmt]), True
    return current_time, False
