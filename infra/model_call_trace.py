"""Per-model-call accounting for the operator's probe (2026-08-21).

Every production model call passes through `infra.llm_retry.RetryingLLM.chat` — `build_llm`
wraps every provider path in it, the Scribe's and Director's dedicated clients included —
so that is where ONE row per LOGICAL call (retries included) is recorded: which lane asked,
how long it took wall-clock, how many attempts it took, and what the provider billed
(prompt / completion / cached tokens). The local run-3 play-test could recover per-call
latency only by reading the gaps between tool clusters in the tool trace, and the session's
46% cache-hit figure was the sum of every lane together: "which call is slow" and "does the
Keeper lane actually hit the cache" were unanswerable. A probe that cannot answer where the
time went is not a probe (the same lesson the image warm-up taught a day earlier).

Shape:
- a lane is declared by the code that ASSEMBLES the prompt (`lane_scope("npc", npc=...)`
  around its call), which is also the iron-rule-5 assembler — so the row names the lane by
  construction, and a nested lane (an NPC voiced inside a Keeper round) restores the outer
  scope when it returns;
- `infra/` cannot import `agent/`, so the sink is pluggable: `agent.tool_trace` installs
  one that writes into the same JSONL the tool probe uses (`tool: "model_call"`), and with
  no sink installed the whole thing costs one ContextVar read per call.
"""

from __future__ import annotations

import contextlib
import contextvars
import logging
from collections.abc import Callable, Generator
from typing import Any

logger = logging.getLogger(__name__)

_LANE: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar("model_call_lane", default=None)
_SINK: Callable[[dict[str, Any]], None] | None = None


def set_sink(sink: Callable[[dict[str, Any]], None] | None) -> None:
    """Install (or clear) the consumer of model-call rows. One sink, process-wide."""
    global _SINK
    _SINK = sink


def sink_installed() -> bool:
    return _SINK is not None


@contextlib.contextmanager
def lane_scope(lane: str, **fields: Any) -> Generator[None, None, None]:
    """Name the lane every model call inside this block belongs to.

    Extra `fields` ride along on each row (`chat_key`, `round`, `npc`, ...); `None` values
    are dropped. Nested scopes override and then RESTORE, so an actor voiced from inside a
    Keeper round reports as its own lane and the next Keeper round reports as the Keeper's.
    """
    scoped = {"lane": lane}
    scoped.update((key, value) for key, value in fields.items() if value is not None)
    token = _LANE.set(scoped)
    try:
        yield
    finally:
        _LANE.reset(token)


def set_lane_field(**fields: Any) -> None:
    """Update fields of the CURRENT lane scope in place (e.g. the Keeper's round index as
    the loop advances). A no-op outside any scope."""
    current = _LANE.get()
    if not current:
        return
    updated = dict(current)
    updated.update((key, value) for key, value in fields.items() if value is not None)
    _LANE.set(updated)


def current_lane() -> dict[str, Any]:
    return dict(_LANE.get() or {})


def record_model_call(
    *,
    ms: float,
    attempts: int,
    usage: Any = None,
    model: str = "",
    error: BaseException | None = None,
) -> None:
    """Hand one finished logical call to the sink. Never raises; free when no sink."""
    if _SINK is None:
        return
    payload: dict[str, Any] = dict(_LANE.get() or {}) or {"lane": ""}
    payload["ms"] = round(float(ms), 1)
    payload["attempts"] = int(attempts)
    if model:
        payload["model"] = str(model)
    if usage is not None:
        for field in ("prompt_tokens", "completion_tokens", "cache_hit_tokens", "cache_miss_tokens"):
            value = getattr(usage, field, None)
            if value is not None:
                payload[field] = int(value)
        if getattr(usage, "estimated", False):
            payload["estimated"] = True
    if error is not None:
        payload["error"] = type(error).__name__
        payload["error_text"] = str(error)[:200]
    try:
        _SINK(payload)
    except Exception:  # noqa: BLE001 — the probe must never cost the call that fed it
        logger.debug("model-call trace sink failed", exc_info=True)
