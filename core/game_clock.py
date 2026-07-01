"""Pure helpers for game clock time advancement."""

import re
from datetime import datetime, timedelta

_TIME_FORMATS = (
    "%Y年%m月%d日 %H:%M",
    "%Y年%m月%d日%H:%M",
    "%Y-%m-%d %H:%M",
    "%Y/%m/%d %H:%M",
    "%Y-%m-%dT%H:%M",
    "%Y年%m月%d日",
    "%Y-%m-%d",
    "%Y/%m/%d",
)

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


def parse_game_datetime(value: str) -> datetime | None:
    """Parse common Chinese/ISO-like game datetime strings."""
    text = value.strip()
    for fmt in _TIME_FORMATS:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


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
    """Advance parseable game time, otherwise preserve the readable fallback chain."""
    current_dt = parse_game_datetime(current_time)
    delta = parse_time_delta(delta_text)
    if current_dt and delta:
        advanced = current_dt + delta
        return advanced.strftime("%Y年%m月%d日 %H:%M"), True
    return f"{current_time} → 推进 {delta_text}", False
