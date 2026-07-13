"""Shared recognition helpers for the built-in offline demo workflow."""

from __future__ import annotations

from infra.i18n import get_i18n

_LEGACY_SETUP_REQUESTS = ("upload the demo module",)  # i18n-exempt: parser tokens


def is_guided_demo_request(text: str) -> bool:
    """Whether the scripted fallback received an explicit guided setup action."""
    lowered = text.strip().lower()
    return lowered in {
        get_i18n("en").t("tui.demo.action").casefold(),
        get_i18n("zh").t("tui.demo.action").casefold(),
    }


def is_demo_setup_request(text: str) -> bool:
    """Whether the fallback would invoke its destructive sample-module setup tools."""
    lowered = text.strip().lower()
    return is_guided_demo_request(lowered) or lowered in _LEGACY_SETUP_REQUESTS
