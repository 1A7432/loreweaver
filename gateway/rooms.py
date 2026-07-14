"""Room binding + resolution — aliasing heterogeneous channels to one session.

The engine scopes every piece of game state by ``chat_key``, and the hub keys
its rooms by the same string, so two connections "share a session" precisely
when they resolve to the SAME key. By default a channel's key is its own
``SessionSource.chat_key()`` (each channel is its own private session). A
``bound_room.{chat_key}`` binding overrides that, pointing the channel at a
shared ``session_key`` instead — the mechanism behind ``.room open`` / ``.room
link`` (see ``gateway.commands``).

Cross-transport identity: ``.room open`` mints a terminal keystore key whose
``room`` is a fresh id, and binds the chat channel to the SAME logical
``session_key`` a terminal joining with that key will land on
(:func:`session_key_for_room`). Both then resolve to one hub room and one engine
``chat_key`` — a shared game.
"""

from __future__ import annotations

import secrets
from typing import TYPE_CHECKING

from gateway.session import SessionSource

if TYPE_CHECKING:
    from infra.store import Store

_BOUND_ROOM_KEY = "bound_room.{chat_key}"
_KEEPER_BINDING_KEY = "chat_keeper.{platform}:{user_id}"
_ROOM_ID_PREFIX = "room-"


async def resolve_session_key(store: Store, source: SessionSource) -> str:
    """The shared session id for ``source``: its binding if set, else its own key."""
    if source.chat_type.casefold() in {"dm", "direct", "private", "c2c"}:
        room = await get_keeper_binding(store, source.platform, source.user_id)
        if room:
            return session_key_for_room(room)
    chat_key = source.chat_key()
    bound = await get_binding(store, chat_key)
    return bound or chat_key


async def get_binding(store: Store, chat_key: str) -> str | None:
    """The ``session_key`` ``chat_key`` is bound to, or ``None`` if unbound."""
    return await store.get(user_key="", store_key=_BOUND_ROOM_KEY.format(chat_key=chat_key))


async def set_binding(store: Store, chat_key: str, session_key: str) -> None:
    """Bind ``chat_key`` to the shared ``session_key``."""
    await store.set(user_key="", store_key=_BOUND_ROOM_KEY.format(chat_key=chat_key), value=session_key)


async def clear_binding(store: Store, chat_key: str) -> None:
    """Remove ``chat_key``'s binding (it reverts to its own private session)."""
    await store.delete(user_key="", store_key=_BOUND_ROOM_KEY.format(chat_key=chat_key))


async def get_keeper_binding(
    store: Store, platform: str, user_id: str | None
) -> str | None:
    if not user_id:
        return None
    raw = await store.get(
        user_key="",
        store_key=_KEEPER_BINDING_KEY.format(platform=platform, user_id=user_id),
    )
    return str(raw) if raw else None


async def set_keeper_binding(store: Store, platform: str, user_id: str, room: str) -> None:
    await store.set(
        user_key="",
        store_key=_KEEPER_BINDING_KEY.format(platform=platform, user_id=user_id),
        value=room,
    )


async def clear_keeper_binding(
    store: Store,
    platform: str,
    user_id: str | None,
    *,
    expected_room: str | None = None,
) -> bool:
    if not user_id:
        return False
    key = _KEEPER_BINDING_KEY.format(platform=platform, user_id=user_id)
    room = await store.get(user_key="", store_key=key)
    if room is None or (expected_room is not None and room != expected_room):
        return False
    return bool(
        await store.delete_rows_if_value((("", key, room),))
    )


async def clear_keeper_bindings_for_room(store: Store, room: str) -> int:
    rows = await store.list_rows(store_key_prefixes=("chat_keeper.",))
    doomed = [
        (
            str(row.get("user_key") or ""),
            str(row.get("store_key") or ""),
            str(row.get("value") or ""),
        )
        for row in rows
        if row.get("value") == room
    ]
    return await store.delete_rows_if_value(doomed)


async def clear_bindings_for_session(store: Store, session_key: str) -> int:
    rows = await store.list_rows(store_key_prefixes=("bound_room.",))
    doomed = [
        (
            str(row.get("user_key") or ""),
            str(row.get("store_key") or ""),
            str(row.get("value") or ""),
        )
        for row in rows
        if row.get("value") == session_key
    ]
    return await store.delete_rows_if_value(doomed)


async def list_keeper_bindings_for_room(store: Store, room: str) -> list[tuple[str, str]]:
    rows = await store.list_rows(store_key_prefixes=("chat_keeper.",))
    bindings: list[tuple[str, str]] = []
    for row in rows:
        key = str(row.get("store_key") or "")
        if row.get("value") != room or not key.startswith("chat_keeper."):
            continue
        identity = key.removeprefix("chat_keeper.")
        platform, separator, user_id = identity.partition(":")
        if separator and platform and user_id:
            bindings.append((platform, user_id))
    return sorted(bindings)


def mint_room_id() -> str:
    """A fresh, opaque logical room id for a newly opened shared room."""
    return f"{_ROOM_ID_PREFIX}{secrets.token_urlsafe(6)}"


def session_key_for_room(room_id: str) -> str:
    """The ``session_key`` a terminal joining ``room_id`` resolves to.

    Mirrors ``net.tui_server.TuiServer._authenticate``, which builds a
    ``SessionSource(platform="tui", chat_type="group", chat_id=entry.room)`` and
    uses its ``chat_key()`` as the member's session key — so binding a chat
    channel to this value puts it in the terminal's exact hub room.
    """
    return SessionSource(platform="tui", chat_type="group", chat_id=room_id).chat_key()
