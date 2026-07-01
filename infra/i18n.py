"""Locale loader — the only sanctioned source of user-visible text.

Catalogs live under ``locales/{locale}/*.json`` (flat, namespaced keys, e.g.
``"dice.result"``). All ``*.json`` files in a locale directory are merged
into one flat dict. Lookup falls back ``requested locale -> en -> the key
itself`` and never raises on a missing key or a missing format parameter.
"""

from __future__ import annotations

import json
import logging
from functools import cache
from pathlib import Path

logger = logging.getLogger(__name__)

DEFAULT_LOCALE = "en"

# infra/i18n.py -> infra/ -> repo root. Resolved once at import time so the
# default catalog location is independent of the process's cwd.
_REPO_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_BASE_DIR = _REPO_ROOT / "locales"

_missing_key_warned: set[tuple[str, str, str]] = set()


@cache
def _load_catalog(base_dir: str, locale: str) -> dict[str, str]:
    """Merge every ``*.json`` file under ``{base_dir}/{locale}/`` into one dict."""
    catalog: dict[str, str] = {}
    locale_dir = Path(base_dir) / locale
    if not locale_dir.is_dir():
        return catalog

    for json_file in sorted(locale_dir.glob("*.json")):
        try:
            with json_file.open("r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, json.JSONDecodeError):
            logger.warning("i18n: failed to load catalog file %s", json_file, exc_info=True)
            continue
        if isinstance(data, dict):
            catalog.update(data)
        else:
            logger.warning("i18n: ignoring non-object catalog file %s", json_file)
    return catalog


def _warn_missing_once(base_dir: str, locale: str, key: str) -> None:
    cache_key = (base_dir, locale, key)
    if cache_key in _missing_key_warned:
        return
    _missing_key_warned.add(cache_key)
    logger.warning("i18n: missing key %r for locale %r (no en fallback either)", key, locale)


class I18n:
    """Bound locale catalog with `str.format`-style interpolation."""

    def __init__(self, locale: str = DEFAULT_LOCALE, base_dir: str | Path = "locales") -> None:
        base = Path(base_dir)
        if not base.is_absolute():
            base = _REPO_ROOT / base
        self._base_dir = base
        self._locale = locale
        self._catalog = _load_catalog(str(self._base_dir), self._locale)

    @property
    def locale(self) -> str:
        return self._locale

    @property
    def base_dir(self) -> Path:
        return self._base_dir

    def with_locale(self, locale: str) -> I18n:
        """Return a bound copy of this loader for a different locale."""
        return I18n(locale=locale, base_dir=self._base_dir)

    def available_locales(self) -> list[str]:
        """List locale directories under `base_dir` that contain at least one catalog file."""
        if not self._base_dir.is_dir():
            return []
        return sorted(p.name for p in self._base_dir.iterdir() if p.is_dir() and any(p.glob("*.json")))

    def _lookup(self, key: str) -> str:
        template = self._catalog.get(key)
        if template is not None:
            return template

        if self._locale != DEFAULT_LOCALE:
            en_catalog = _load_catalog(str(self._base_dir), DEFAULT_LOCALE)
            template = en_catalog.get(key)
            if template is not None:
                return template

        _warn_missing_once(str(self._base_dir), self._locale, key)
        return key

    def t(self, key: str, /, **params) -> str:
        """Render `key` via `str.format(**params)`.

        Falls back requested locale -> en -> the raw key string on a
        missing key, and leaves the template unformatted (raw) if a
        `{placeholder}` has no matching param, rather than raising.
        """
        template = self._lookup(key)
        if not params:
            return template
        try:
            return template.format(**params)
        except (KeyError, IndexError, ValueError):
            # Missing placeholder param (KeyError/IndexError) or a malformed template
            # (ValueError, e.g. an unbalanced brace / bad format spec): return the raw
            # template rather than ever raising out of a user-facing string lookup.
            return template


_default_i18n: I18n | None = None


def _get_default_i18n() -> I18n:
    global _default_i18n
    if _default_i18n is None:
        # Imported lazily to avoid a hard import-time coupling between the
        # i18n and config modules for callers that only need one of them.
        from infra.config import get_settings

        _default_i18n = I18n(locale=get_settings().locale)
    return _default_i18n


def get_i18n(locale: str | None = None) -> I18n:
    """Module-level convenience bound to the configured default locale."""
    default = _get_default_i18n()
    if locale is None or locale == default.locale:
        return default
    return default.with_locale(locale)


def t(key: str, /, locale: str | None = None, **params) -> str:
    """Module-level convenience: `t("dice.result", total=7)`."""
    return get_i18n(locale).t(key, **params)
