from __future__ import annotations

import json
import re
import time
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from enum import IntEnum, IntFlag
from pathlib import Path
from typing import TYPE_CHECKING, Any

from infra.i18n import t

if TYPE_CHECKING:
    from infra.config import CensorSettings

_BOT_ENABLED_PREFIX = "bot_enabled."
_BOT_ENABLED_VALUE = "1"
_BOT_DISABLED_VALUE = "0"
_DIRECT_CHAT_TYPES = {"dm", "direct", "private"}
_CENSOR_MASK_KEY = "ops.censor.mask"
# Inter-letter "noise" allowed inside a banned word so an obfuscated spelling
# ("b a d w o r d", "b.a.d") still matches: whitespace (`\s`), common punctuation
# obfuscators (dot, asterisk, middle-dot, hyphen), and a few zero-width /
# soft-hyphen format chars. None of these are `\w`, so the word-boundary
# lookarounds around a hit are unaffected. Written with explicit escapes so no
# literal invisible characters live in the source.
_CENSOR_SEP_CHARS = ".*-\u00b7\u200b\u200c\u200d\ufeff\u00ad"
_CENSOR_SEP = r"[\s" + re.escape(_CENSOR_SEP_CHARS) + r"]*"
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


def _normalize_for_match(text: str) -> tuple[str, list[int]]:
    """NFKC + casefold `text` per character.

    Returns the normalized string plus a map from each normalized-char index back
    to its originating index in the ORIGINAL `text`. Folding fullwidth/compatibility
    and case variants defeats a naive matcher's blind spots (fullwidth `ｂａｄ`, mixed
    case), while the per-character map keeps offsets exact so a masked span still
    lands on the original text.
    """
    normalized: list[str] = []
    origin: list[int] = []
    for index, char in enumerate(text):
        folded = unicodedata.normalize("NFKC", char).casefold()
        for piece in folded:
            normalized.append(piece)
            origin.append(index)
    return "".join(normalized), origin


def _compile_censor_word(word: str) -> re.Pattern[str] | None:
    """Compile a banned `word` into a bypass-resistant matcher.

    The word is normalized the same way inbound text is, then each letter is joined
    by `_CENSOR_SEP` (so obfuscation spacing/punctuation between letters still
    matches) and anchored with `\\w` boundaries so it only fires on a whole word,
    never a substring (no "Scunthorpe problem"). Returns `None` for an all-noise
    word that would compile to an empty matcher.
    """
    normalized, _ = _normalize_for_match(word)
    letters = [char for char in normalized if not char.isspace()]
    if not letters:
        return None
    core = _CENSOR_SEP.join(re.escape(char) for char in letters)
    return re.compile(rf"(?<!\w){core}(?!\w)")


class Censor:
    """Bypass-resistant wordlist matcher (NFKC+casefold, de-obfuscation,
    whole-word boundaries, offset-preserving masking -- see the module-level
    helpers above).

    `wordlist` is empty by default (``Censor()`` / ``Censor(None)``): with no
    banned words compiled, ``review()`` takes its `not self._patterns` early
    return on EVERY call, so an unconfigured `Censor` is an explicit no-op,
    never a false impression of moderation. Build a real one via
    `censor_from_settings`/`load_wordlist` (see `infra.config.CensorSettings`
    and `docs/deploy.md` "Content moderation").
    """

    def __init__(self, wordlist: dict[str, int] | None = None) -> None:
        source = wordlist or {}
        self._wordlist = {word: self._normalize_level(level) for word, level in source.items() if word}
        # Precompiled, normalization-aware matcher per banned word (skipping any that
        # reduce to nothing). Matching runs against a normalized copy of the input.
        self._patterns: dict[str, re.Pattern[str]] = {}
        for word in self._wordlist:
            pattern = _compile_censor_word(word)
            if pattern is not None:
                self._patterns[word] = pattern

    def review(self, text: str) -> CensorResult:
        if not text or not self._patterns:
            return CensorResult(
                allowed=True,
                cleaned=text,
                level=int(CensorLevel.NONE),
                hits=[],
            )

        normalized, origin = _normalize_for_match(text)

        spans: list[tuple[int, int]] = []
        hits: list[str] = []
        highest_level = int(CensorLevel.NONE)

        for word, pattern in self._patterns.items():
            matched = False
            for match in pattern.finditer(normalized):
                start, end = match.start(), match.end()
                if end <= start:
                    continue
                # Map the normalized-coordinate span back onto the original text so the
                # mask covers exactly the original (possibly obfuscated) characters.
                spans.append((origin[start], origin[end - 1] + 1))
                matched = True
            if matched:
                hits.append(word)
                highest_level = max(highest_level, self._wordlist[word])

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


def load_wordlist(*, path: str = "", inline: str = "") -> dict[str, int]:
    """Build a `Censor` wordlist from a JSON file and/or an inline spec.

    Both blank (the default) returns `{}` -- `Censor(load_wordlist())` is then
    the explicit no-op the empty-wordlist contract promises, never a stand-in
    profanity list. `path` is a JSON file `{"word": level, ...}`; `inline` is
    a comma-separated `word[:level],word2[:level2],...` list (env-var
    friendly, no file needed). Both may be combined; `inline` entries win on a
    key collision. See `infra.config.CensorSettings` for the deployer-facing
    knobs this feeds (`censor_from_settings` wires them together).
    """
    wordlist: dict[str, int] = {}
    if path:
        wordlist.update(_load_wordlist_file(path))
    if inline:
        wordlist.update(_parse_inline_wordlist(inline))
    return wordlist


def censor_from_settings(settings: CensorSettings) -> Censor:
    """Build the production `Censor` from `infra.config.CensorSettings`.

    The single wiring point both `gateway.runner.GatewayRunner` and
    `net.tui_server.TuiServer` use so a deployer's config actually reaches the
    matcher -- with nothing configured this is `Censor({})`, the explicit
    no-op (see `Censor`'s docstring), not a fake "badword"-only placeholder.
    """
    return Censor(load_wordlist(path=settings.wordlist_path, inline=settings.wordlist))


def _load_wordlist_file(path: str) -> dict[str, int]:
    try:
        raw = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        # Operator/config misuse at startup, not user-facing chat text.
        raise ValueError(f"censor wordlist file not readable: {path} ({exc})") from exc  # i18n-exempt
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"censor wordlist file is not valid JSON: {path} ({exc})") from exc  # i18n-exempt
    if not isinstance(data, dict):
        raise ValueError(f"censor wordlist file must be a JSON object of word -> level: {path}")  # i18n-exempt
    return {str(word): _coerce_level(level) for word, level in data.items() if str(word).strip()}


def _parse_inline_wordlist(inline: str) -> dict[str, int]:
    wordlist: dict[str, int] = {}
    for entry in inline.split(","):
        word, _, level = entry.strip().partition(":")
        word = word.strip()
        if not word:
            continue
        wordlist[word] = _coerce_level(level.strip()) if level.strip() else int(CensorLevel.NOTICE)
    return wordlist


def _coerce_level(level: Any) -> int:
    try:
        return int(level)
    except (TypeError, ValueError):
        return int(CensorLevel.NOTICE)


async def is_bot_enabled(store, chat_key: str) -> bool:
    value = await store.get(store_key=f"{_BOT_ENABLED_PREFIX}{chat_key}")
    return value == _BOT_ENABLED_VALUE


async def set_bot_enabled(store, chat_key: str, on: bool) -> None:
    value = _BOT_ENABLED_VALUE if on else _BOT_DISABLED_VALUE
    await store.set(store_key=f"{_BOT_ENABLED_PREFIX}{chat_key}", value=value)


def requires_at_mention(chat_type: str) -> bool:
    return chat_type.lower() not in _DIRECT_CHAT_TYPES


class Botlist:
    """Manually curated anti-loop ignore list, keyed by ``SessionSource.user_key()``
    (``"{platform}:{user_id}"``).

    ``gateway.runner.GatewayRunner`` consults ``is_bot`` on every inbound message
    ALONGSIDE ``SessionSource.is_bot`` (see its ``on_inbound``): the platform-native
    flag covers adapters that mark a message's author as a bot (Discord); this list
    covers the rest (Telegram/Feishu/QQ-OneBot none currently populate ``is_bot``,
    so a second bot sharing one of those rooms would otherwise be treated as an
    ordinary player and the two could loop off each other's replies forever).
    Populated at runtime via the ``.botlist add`` keeper command
    (``gateway.commands.CommandRouter.cmd_botlist``); process-lifetime only, not
    persisted, matching ``RateLimiter``'s in-memory-only precedent.
    """

    def __init__(self, ids: set[str] | None = None) -> None:
        self._ids = set() if ids is None else set(ids)

    def add(self, bot_id: str) -> None:
        self._ids.add(bot_id)

    def remove(self, bot_id: str) -> None:
        self._ids.discard(bot_id)

    def is_bot(self, sender_id: str) -> bool:
        return sender_id in self._ids

    def list_ids(self) -> list[str]:
        return sorted(self._ids)


class PrivilegeLevel(IntEnum):
    EVERYONE = 0
    TRUSTED = 1
    GROUP_ADMIN = 2
    MASTER = 3


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
    "PrivilegeLevel",
    "RateLimiter",
    "censor_from_settings",
    "is_bot_enabled",
    "load_wordlist",
    "requires_at_mention",
    "sanitize_outbound",
    "set_bot_enabled",
]
