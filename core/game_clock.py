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


# Module-card day faces ("D1 上午 09:30", "第3天 22:00"): a relative day counter with an
# optional decorative period word (上午/深夜/…) before the time. Imported ST module cards
# keep time this way, and `game_clock set` stores faces verbatim — so `advance` must speak
# the family too (the 2026-08-05 play-test had the KP stuck re-setting the day by hand).
# Advancing keeps the D/第 style and RECOMPUTES day+time, dropping the period word: the
# narration re-adds flavor, while a stale "上午" carried past 21:00 would simply lie.
_DAY_FACE_RE = re.compile(
    r"^(?:[Dd](\d{1,4})|第(\d{1,4})[天日])\s*(?:[^\d\s:：]{1,3})?\s*(\d{1,2})[:：](\d{2})\s*(?:[^\d\s:：]{1,3})?$"
)


def _parse_day_face(value: str) -> tuple[str, int, int, int] | None:
    """``(style, day, hour, minute)`` for a day-face clock, ``None`` otherwise.

    ``style`` is ``"D"`` or ``"第"`` so advancing preserves the family the table uses."""
    match = _DAY_FACE_RE.match(value.strip())
    if not match:
        return None
    style = "D" if match.group(1) else "第"
    day = int(match.group(1) or match.group(2))
    hour, minute = int(match.group(3)), int(match.group(4))
    if not (1 <= day <= 9999 and 0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return style, day, hour, minute


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
    delta = parse_time_delta(delta_text)
    day_face = _parse_day_face(current_time)
    if day_face and delta:
        style, day, hour, minute = day_face
        anchor = datetime(2000, 1, 1) + timedelta(days=day - 1, hours=hour, minutes=minute)
        advanced = anchor + delta
        new_day = (advanced - datetime(2000, 1, 1)).days + 1
        if new_day < 1:
            return current_time, False
        face = f"D{new_day} {advanced:%H:%M}" if style == "D" else f"第{new_day}天 {advanced:%H:%M}"
        return face, True
    current_dt, fmt = _parse_with_format(current_time)
    if current_dt and delta and fmt:
        advanced = current_dt + delta
        return advanced.strftime(_TIME_FORMATS[fmt]), True
    return current_time, False
