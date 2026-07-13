"""Shared recognition helpers for the built-in offline demo workflow."""

from __future__ import annotations

_GUIDED_MARKERS = ("sample adventure", "示例冒险")  # i18n-exempt: parser tokens
_LEGACY_SETUP_MARKERS = ("upload", "module")  # i18n-exempt: parser tokens


def is_guided_demo_request(text: str) -> bool:
    """Whether the scripted fallback should run its one-turn guided setup."""
    lowered = text.strip().lower()
    return any(marker in lowered for marker in _GUIDED_MARKERS)


def is_demo_setup_request(text: str) -> bool:
    """Whether the fallback would invoke its destructive sample-module setup tools."""
    lowered = text.strip().lower()
    return is_guided_demo_request(lowered) or any(marker in lowered for marker in _LEGACY_SETUP_MARKERS)
