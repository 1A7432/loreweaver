"""Live authorization at a commit boundary.

Long or destructive keeper ops re-check after preflight and immediately
before the first irreversible write. The last successful reauth is the
linearization point. Fail closed: a missing callback is allowed only when
the caller opts in (CLI auto-master, internal room_backup ``None``).
Network transports (``tui`` / ``iroh``) must supply a live callback.
"""

from __future__ import annotations

import inspect
from typing import Any

NETWORK_LIVE_AUTH_PLATFORMS = frozenset({"tui", "iroh"})


class AuthorizationRevoked(Exception):
    """Live authorization failed at a commit boundary.

    The last successful reauth is the linearization point: callers must fail
    closed (no backup created or overwritten, no storage/key/vector/media
    change) and map this to the existing forbidden/denied copy. The message is
    empty on purpose so a leaky ``str(exc)`` cannot reveal a path or snapshot.
    """


def missing_ok_for_platform(platform: str) -> bool:
    """True when a missing callback may pass (CLI / unspecified local)."""
    return str(platform or "").casefold() not in NETWORK_LIVE_AUTH_PLATFORMS


async def invoke_reauthorize(reauthorize: Any, *, missing_ok: bool = True) -> bool:
    """Run an optional live-authorization callback (sync or awaitable).

    ``None`` means the caller does not require a live check when ``missing_ok``.
    A non-callable callback, a raising callback, or a falsey result fail closed.
    The callback is sync on the current transports; awaiting a future result
    keeps the helper honest if a refresh ever becomes I/O.
    """
    if reauthorize is None:
        return missing_ok
    if not callable(reauthorize):
        return False
    try:
        result = reauthorize()
        if inspect.isawaitable(result):
            result = await result
    except Exception:
        return False
    return bool(result)


async def confirm_live_authorization(reauthorize: Any) -> None:
    """Raise ``AuthorizationRevoked`` unless the optional callback still grants access.

    A missing callback is allowed here: room_backup and other internal callers
    pass ``None`` when no live check is required.
    """
    if not await invoke_reauthorize(reauthorize, missing_ok=True):
        raise AuthorizationRevoked()


async def ctx_still_authorized(ctx: Any) -> bool:
    """Live-check ``ctx.extra['reauthorize']``, fail-closed on network platforms."""
    extra = getattr(ctx, "extra", None)
    reauthorize = extra.get("reauthorize") if isinstance(extra, dict) else None
    return await invoke_reauthorize(
        reauthorize,
        missing_ok=missing_ok_for_platform(getattr(ctx, "platform", "")),
    )
