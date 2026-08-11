"""Best-effort per-room LLM usage accounting shared by all call sites."""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

from infra.llm import Usage, context_window_for

if TYPE_CHECKING:
    from infra.store import Store

logger = logging.getLogger(__name__)

_EMPTY_SESSION = {
    "prompt": 0,
    "completion": 0,
    "cache_hit": 0,
    "cache_miss": 0,
    "turns": 0,
}


async def record_usage_stats(
    store: Store,
    chat_key: str,
    usage: Usage | None,
    *,
    model: str,
    context_window: int = 0,
) -> None:
    """Persist one LLM call's usage in the room's rolling aggregate.

    The aggregate lives at ``usage_stats.{chat_key}`` and is consumed by the
    room-state renderer and by the chronicle fold's trigger. Missing, corrupt, or
    unreadable prior data starts a fresh aggregate; persistence failures are
    logged and never fail the LLM operation that produced the usage.

    Two halves with deliberately different rules:

    - ``last`` describes THIS turn's assembled prompt — the fold's meter. It
      accepts an ESTIMATED reading (an endpoint that reports nothing at all still
      needs an honest number, since "no meter" reads as "no pressure" and
      disables the fold outright) and stamps ``estimated`` so no reader can
      mistake one for a measured count.
    - ``session`` is the cumulative token counter behind the HUD's input/output
      figures. It stays MEASURED-ONLY: those are the numbers an operator checks
      against a vendor's bill, and folding guesses into them would make an
      approximation indistinguishable from an invoice. An estimated turn
      therefore leaves the running totals exactly where they were.
    """
    if usage is None or not any(
        (
            usage.prompt_tokens,
            usage.completion_tokens,
            usage.total_tokens,
            usage.cache_hit_tokens,
            usage.cache_miss_tokens,
        )
    ):
        return

    key = "usage_stats"
    session = dict(_EMPTY_SESSION)
    try:
        raw = await store.state_get(chat_key, key)
        prior = json.loads(raw) if raw else {}
        prior_session = prior.get("session") if isinstance(prior, dict) else None
        if isinstance(prior_session, dict):
            for field_name in session:
                session[field_name] = int(prior_session.get(field_name, 0) or 0)
    except Exception:
        # A corrupt or unreadable aggregate must not hide the current call's
        # valid usage. Start fresh and still attempt the write below.
        session = dict(_EMPTY_SESSION)

    if not usage.estimated:
        session["prompt"] += usage.prompt_tokens
        session["completion"] += usage.completion_tokens
        session["cache_hit"] += usage.cache_hit_tokens
        session["cache_miss"] += usage.cache_miss_tokens
        session["turns"] += 1

    payload = {
        "last": {
            "prompt": usage.prompt_tokens,
            "completion": usage.completion_tokens,
            "cache_hit": usage.cache_hit_tokens,
            "cache_miss": usage.cache_miss_tokens,
            "context_window": context_window_for(model, context_window),
            "estimated": usage.estimated,
        },
        "session": session,
    }
    try:
        await store.state_set(
            chat_key,
            key,
            json.dumps(payload, ensure_ascii=False),
        )
    except Exception:
        logger.warning(
            "usage_stats: failed to persist for chat_key=%s",
            chat_key,
            exc_info=True,
        )
