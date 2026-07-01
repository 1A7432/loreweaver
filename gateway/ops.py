from __future__ import annotations

import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from enum import IntEnum, IntFlag

from infra.i18n import t

_BOT_ENABLED_PREFIX = "bot_enabled."
_BOT_ENABLED_VALUE = "1"
_BOT_DISABLED_VALUE = "0"
_DIRECT_CHAT_TYPES = {"dm", "direct", "private"}
_CENSOR_MASK_KEY = "ops.censor.mask"
_SANITIZER_URL_KEY = "ops.sanitizer.url"
_MASS_MENTION_RE = re.compile(r"@(?:everyone|here)\b", re.IGNORECASE)
_URL_RE = re.compile(r"(?<![\w@])(?P<url>(?:https?://|www\.)[^\s<>()]+)", re.IGNORECASE)
_URL_TRAILING_PUNCTUATION = ".,!?;:"


class RateLimiter:
    def __init__(
        self,
        capacity: int = 5,
        refill_per_sec: float = 0.5,
        *,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self.capacity = float(capacity)
        self.refill_per_sec = float(refill_per_sec)
        self._now = now
        self._buckets: dict[str, tuple[float, float]] = {}

    def allow(self, key: str) -> bool:
        now = self._now()
        tokens, last_seen = self._buckets.get(key, (self.capacity, now))
        elapsed = max(0.0, now - last_seen)
        tokens = min(self.capacity, tokens + elapsed * self.refill_per_sec)

        if tokens < 1.0:
            self._buckets[key] = (tokens, now)
            return False

        self._buckets[key] = (tokens - 1.0, now)
        return True


class CensorLevel(IntEnum):
    NONE = 0
    NOTICE = 1
    CAUTION = 2
    WARNING = 3
    DANGER = 4
    FORBIDDEN = 5


class CensorDisposition(IntFlag):
    ALLOW = 0
    MASK = 1
    BLOCK = 2


@dataclass(frozen=True)
class CensorResult:
    allowed: bool
    cleaned: str
    level: int
    hits: list[str]
    disposition: CensorDisposition = CensorDisposition.ALLOW


_DEFAULT_WORDLIST = {"badword": int(CensorLevel.DANGER)}


class Censor:
    def __init__(self, wordlist: dict[str, int] | None = None) -> None:
        source = _DEFAULT_WORDLIST if wordlist is None else wordlist
        self._wordlist = {word: self._normalize_level(level) for word, level in source.items() if word}

    def review(self, text: str) -> CensorResult:
        if not text or not self._wordlist:
            return CensorResult(
                allowed=True,
                cleaned=text,
                level=int(CensorLevel.NONE),
                hits=[],
            )

        spans: list[tuple[int, int]] = []
        hits: list[str] = []
        highest_level = int(CensorLevel.NONE)

        for word, level in self._wordlist.items():
            word_spans = [
                (match.start(), match.end())
                for match in re.finditer(re.escape(word), text, flags=re.IGNORECASE)
            ]
            if not word_spans:
                continue
            hits.append(word)
            spans.extend(word_spans)
            highest_level = max(highest_level, level)

        if not spans:
            return CensorResult(
                allowed=True,
                cleaned=text,
                level=int(CensorLevel.NONE),
                hits=[],
            )

        cleaned = self._mask_spans(text, spans)
        disposition = CensorDisposition.MASK
        if highest_level >= int(CensorLevel.DANGER):
            disposition |= CensorDisposition.BLOCK

        return CensorResult(
            allowed=not bool(disposition & CensorDisposition.BLOCK),
            cleaned=cleaned,
            level=highest_level,
            hits=hits,
            disposition=disposition,
        )

    @staticmethod
    def _normalize_level(level: int) -> int:
        return max(int(CensorLevel.NOTICE), min(int(CensorLevel.FORBIDDEN), int(level)))

    @staticmethod
    def _mask_spans(text: str, spans: list[tuple[int, int]]) -> str:
        mask = t(_CENSOR_MASK_KEY)
        merged: list[tuple[int, int]] = []
        for start, end in sorted(spans):
            if not merged or start >= merged[-1][1]:
                merged.append((start, end))
                continue
            previous_start, previous_end = merged[-1]
            merged[-1] = (previous_start, max(previous_end, end))

        chunks: list[str] = []
        cursor = 0
        for start, end in merged:
            chunks.append(text[cursor:start])
            chunks.append(mask)
            cursor = end
        chunks.append(text[cursor:])
        return "".join(chunks)


async def is_bot_enabled(store, chat_key: str) -> bool:
    value = await store.get(store_key=f"{_BOT_ENABLED_PREFIX}{chat_key}")
    return value == _BOT_ENABLED_VALUE


async def set_bot_enabled(store, chat_key: str, on: bool) -> None:
    value = _BOT_ENABLED_VALUE if on else _BOT_DISABLED_VALUE
    await store.set(store_key=f"{_BOT_ENABLED_PREFIX}{chat_key}", value=value)


def requires_at_mention(chat_type: str) -> bool:
    return chat_type.lower() not in _DIRECT_CHAT_TYPES


class Botlist:
    def __init__(self, ids: set[str] | None = None) -> None:
        self._ids = set() if ids is None else set(ids)

    def add(self, bot_id: str) -> None:
        self._ids.add(bot_id)

    def is_bot(self, sender_id: str) -> bool:
        return sender_id in self._ids


class PrivilegeLevel(IntEnum):
    EVERYONE = 0
    TRUSTED = 1
    GROUP_ADMIN = 2
    MASTER = 3


class PermissionGate:
    def __init__(self, masters: set[str] | None = None, *, claim_code: str | None = None) -> None:
        self._masters = set() if masters is None else set(masters)
        self._claim_code = self._normalize_claim_code(claim_code) if claim_code is not None else secrets.token_hex(4)

    def level_of(self, user_key: str, *, is_group_admin: bool = False) -> PrivilegeLevel:
        if user_key in self._masters:
            return PrivilegeLevel.MASTER
        if is_group_admin:
            return PrivilegeLevel.GROUP_ADMIN
        return PrivilegeLevel.EVERYONE

    def allowed(
        self,
        user_key: str,
        required: PrivilegeLevel,
        *,
        is_group_admin: bool = False,
    ) -> bool:
        return self.level_of(user_key, is_group_admin=is_group_admin) >= required

    def rotating_claim_code(self) -> str:
        return self._claim_code

    def claim_master(self, user_key: str, code: str) -> bool:
        if code != self._claim_code:
            return False
        self._masters.add(user_key)
        return True

    @staticmethod
    def _normalize_claim_code(code: str) -> str:
        return code[:8].ljust(8, "0")


class ContentSanitizer:
    def __init__(self, *, locale: str | None = None) -> None:
        self._locale = locale

    def sanitize_outbound(self, text: str) -> str:
        without_mass_mentions = _MASS_MENTION_RE.sub("", text)
        return _URL_RE.sub(self._replace_url, without_mass_mentions)

    def _replace_url(self, match: re.Match[str]) -> str:
        url = match.group("url")
        suffix = ""
        while url and url[-1] in _URL_TRAILING_PUNCTUATION:
            suffix = f"{url[-1]}{suffix}"
            url = url[:-1]

        return f"{t(_SANITIZER_URL_KEY, locale=self._locale, url=_neutralize_url(url))}{suffix}"


def sanitize_outbound(text: str) -> str:
    return ContentSanitizer().sanitize_outbound(text)


def _neutralize_url(url: str) -> str:
    if url.lower().startswith("www."):
        return f"{url[:3]}[.]{url[4:].replace('.', '[.]')}"
    return url.replace("://", "[:]//").replace(".", "[.]")


__all__ = [
    "Botlist",
    "Censor",
    "CensorDisposition",
    "CensorLevel",
    "CensorResult",
    "ContentSanitizer",
    "PermissionGate",
    "PrivilegeLevel",
    "RateLimiter",
    "is_bot_enabled",
    "requires_at_mention",
    "sanitize_outbound",
    "set_bot_enabled",
]
