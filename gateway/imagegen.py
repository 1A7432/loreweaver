"""Shared image-generation helpers for commands and KP tools."""

from __future__ import annotations

import re

from agent.services import Services
from gateway.ops import RateLimiter

_LIMITERS: dict[tuple[int, int], RateLimiter] = {}


def allow_imagegen_request(services: Services, chat_key: str) -> bool:
    capacity = int(services.settings.imagegen.per_room_per_hour)
    if capacity <= 0:
        return False
    key = (id(services.store), capacity)
    limiter = _LIMITERS.get(key)
    if limiter is None:
        limiter = RateLimiter(capacity, capacity / 3600.0)
        _LIMITERS[key] = limiter
    return limiter.allow(f"imagegen:{chat_key}")


def image_name(kind: str, prompt: str, *, ext: str = ".png") -> str:
    safe_kind = _slug(kind) or "image"
    safe_prompt = _slug(prompt)[:40] or "generated"
    return f"{safe_kind}-{safe_prompt}{ext}"


def reset_imagegen_limiters() -> None:
    _LIMITERS.clear()


def _slug(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "-", str(value).strip().lower()).strip("-_")
