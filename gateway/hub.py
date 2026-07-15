"""RoomHub — the transport-agnostic session bus (M6 Phase 1).

The engine already scopes every piece of game state by ``chat_key`` (see
``net.state.build_room_state`` and the ``*.{chat_key}`` store keys), so any two
connections that resolve to the same ``session_key`` are, by construction,
playing the same session. What was missing is the *live* piece: a broadcast
bus that fans one turn's results out to every currently-connected member,
regardless of which transport each member speaks.

``RoomHub`` is that bus. It knows nothing about WebSockets, Discord cards or
SSH ptys — it only holds ``session_key -> {Member}`` and calls
``member.deliver(event)`` for each normalized :class:`Event`. Every concrete
transport supplies its own :class:`Member` whose ``deliver`` renders the event
into that transport's native frames (the terminal ``WsMember`` in
``net.tui_server`` is the first one). A member whose ``deliver`` raises is
dropped and logged; it never aborts the fan-out to the rest of the room.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

logger = logging.getLogger(__name__)


@dataclass
class Event:
    """One normalized, transport-agnostic thing that happened in a session.

    ``kind`` tags the union; the remaining fields are populated per kind and
    left at their defaults otherwise. Each transport's renderer reads only the
    fields relevant to ``kind`` (e.g. a ``dice`` event carries its roll data in
    ``data``, a ``narrative`` event carries ``speaker``/``text``/``fmt``).
    """

    kind: str  # "player_action" | "dice" | "narrative" | "state" | "presence" | "system" | "media" | "audio"
    speaker: str = ""  # narrative: "kp" | "npc" | "player" | "system"
    name: str = ""  # actor / npc / player display name
    text: str = ""  # narrative / system text
    fmt: str = "plain"  # "markdown" | "plain"
    data: dict[str, Any] = field(default_factory=dict)  # dice fields / state snapshot / presence list / {level}
    private: bool = False

    @classmethod
    def player_action(cls, name: str, text: str) -> Event:
        """A player's raw input, echoed back to the whole room."""
        return cls(kind="player_action", name=name, text=text, fmt="plain")

    @classmethod
    def dice(cls, actor: str, kind: str, **fields: Any) -> Event:
        """A dice roll / check. ``kind`` is the roll kind (``roll``/``check``/…);
        ``fields`` carry the rendered roll data (``expr``/``rolls``/``total``/…)."""
        return cls(kind="dice", data={"actor": actor, "kind": kind, **fields})

    @classmethod
    def narrative(
        cls,
        speaker: str,
        text: str,
        *,
        name: str = "",
        fmt: str = "markdown",
        private: bool = False,
    ) -> Event:
        """One line of story / dialogue from ``speaker`` (kp/npc/player/system)."""
        return cls(kind="narrative", speaker=speaker, name=name, text=text, fmt=fmt, private=private)

    @classmethod
    def state(cls, snapshot: dict[str, Any]) -> Event:
        """A room panel snapshot (see ``net.state.build_room_state``)."""
        return cls(kind="state", data=dict(snapshot))

    @classmethod
    def panel(cls, snapshot: dict[str, Any], *, private: bool = False) -> Event:
        return cls(kind="panel", data=dict(snapshot), private=private)

    @classmethod
    def presence(cls, players: list[dict[str, Any]], online: int) -> Event:
        """The connected-member roster and its count."""
        return cls(kind="presence", data={"players": list(players), "online": online})

    @classmethod
    def system(cls, level: str, text: str) -> Event:
        """An out-of-band notice (``level`` = ``info``/``warn``)."""
        return cls(kind="system", text=text, data={"level": level})

    @classmethod
    def media(cls, frame: dict[str, Any]) -> Event:
        """A media metadata frame. Bytes are fetched separately on demand."""
        return cls(kind="media", data=dict(frame))

    @classmethod
    def audio(cls, frame: dict[str, Any]) -> Event:
        """An audio library/control/state frame. Bytes are fetched separately on demand."""
        return cls(kind="audio", data=dict(frame))


@runtime_checkable
class Member(Protocol):
    """A single participant in a room, on some transport.

    Concrete members (a WebSocket connection, a Discord channel binding, …)
    supply their own ``deliver`` that renders an :class:`Event` into that
    transport's native frames. ``id`` identifies the connection/binding,
    ``user_key`` the human behind it, ``transport`` the medium.
    """

    id: str
    user_key: str
    transport: str

    async def deliver(self, event: Event) -> None:
        """Render ``event`` and send it over this transport."""
        ...


class RoomHub:
    """A shared, in-process broadcast bus: ``session_key -> {Member}``.

    All state is game-scoped by ``session_key`` (the engine's ``chat_key``), so
    every member of a room shares one AI-KP session. The hub is deliberately
    dumb about transports: :meth:`publish` just calls ``deliver`` on each
    member, and each member knows how to render for its own medium.
    """

    def __init__(self) -> None:
        self.rooms: dict[str, set[Member]] = {}
        # Per-room turn lock (F8): the engine locks each individual store get/set, but
        # nothing serializes a caller's read->mutate->write of the shared per-`chat_key`
        # JSON blobs (party roster, KP history, knowledge pool, worldbook index). Two
        # turns interleaving on the SAME room (two transports on one room in combined
        # mode, or a multiplayer room) could lost-update those. `turn_lock` hands each
        # room its own `asyncio.Lock` so a whole turn runs one-at-a-time per room, while
        # DIFFERENT rooms keep distinct locks and still run concurrently. Held by the
        # transport choke points (`net.tui_server.dispatch_input`,
        # `gateway.runner._answer_on_hub`), NOT by `run_turn` itself — so the companion/
        # director sub-turn (which re-enters `run_turn` directly, never a choke point)
        # never re-acquires the room's lock and so cannot self-deadlock.
        self._turn_locks: dict[str, asyncio.Lock] = {}

    def turn_lock(self, session_key: str) -> asyncio.Lock:
        """The (lazily created) `asyncio.Lock` that serializes whole turns for `session_key`.

        Stable per key (same key -> same lock, so concurrent turns on one room contend)
        and distinct across keys (different rooms never block each other). Acquire it once,
        around a whole turn, at a transport choke point; never nest the same room's lock.
        """
        lock = self._turn_locks.get(session_key)
        if lock is None:
            lock = asyncio.Lock()
            self._turn_locks[session_key] = lock
        return lock

    async def subscribe(self, session_key: str, member: Member) -> None:
        """Add ``member`` to ``session_key``'s room and broadcast the new roster."""
        self.rooms.setdefault(session_key, set()).add(member)
        await self._emit_presence(session_key)

    async def unsubscribe(self, member: Member) -> None:
        """Drop ``member`` from whatever room it is in and broadcast the roster."""
        for session_key in list(self.rooms):
            members = self.rooms.get(session_key)
            if members is None or member not in members:
                continue
            members.discard(member)
            if not members:
                self.rooms.pop(session_key, None)
            await self._emit_presence(session_key)

    async def publish(self, session_key: str, event: Event, *, exclude: Member | None = None) -> None:
        """Fan ``event`` out to every member of ``session_key`` (except ``exclude``).

        A member whose ``deliver`` raises is dropped and logged; the fan-out to
        the remaining members always completes.
        """
        members = self.rooms.get(session_key)
        if not members:
            return
        targets = [member for member in list(members) if member is not exclude]
        results = await asyncio.gather(
            *(member.deliver(event) for member in targets),
            return_exceptions=True,
        )
        dropped = False
        for member, result in zip(targets, results, strict=True):
            if isinstance(result, BaseException) and not isinstance(result, Exception):
                raise result
            if isinstance(result, Exception):
                logger.warning(
                    "hub: dropping member %s after deliver failed: %s",
                    getattr(member, "id", member),
                    type(result).__name__,
                )
                members.discard(member)
                dropped = True
        if dropped:
            await self._reconcile_after_drop(session_key, members)

    async def publish_each(
        self,
        session_key: str,
        build: Callable[[Member], Awaitable[Event]],
        *,
        exclude: Member | None = None,
    ) -> None:
        """Build one event per member, preserving the normal drop-on-send-failure policy."""
        members = self.rooms.get(session_key)
        if not members:
            return
        targets = [member for member in list(members) if member is not exclude]

        built = await asyncio.gather(*(build(member) for member in targets), return_exceptions=True)
        ready: list[tuple[Member, Event]] = []
        for member, result in zip(targets, built, strict=True):
            if isinstance(result, BaseException) and not isinstance(result, Exception):
                raise result
            if isinstance(result, Exception):
                logger.warning(
                    "hub: could not build personalized event for %s: %s",
                    getattr(member, "id", member),
                    type(result).__name__,
                )
            else:
                ready.append((member, result))

        results = await asyncio.gather(
            *(member.deliver(event) for member, event in ready),
            return_exceptions=True,
        )
        dropped = False
        for (member, _event), result in zip(ready, results, strict=True):
            if isinstance(result, BaseException) and not isinstance(result, Exception):
                raise result
            if isinstance(result, Exception):
                logger.warning(
                    "hub: dropping member %s after deliver failed: %s",
                    getattr(member, "id", member),
                    type(result).__name__,
                )
                members.discard(member)
                dropped = True
        if dropped:
            await self._reconcile_after_drop(session_key, members)

    async def _reconcile_after_drop(self, session_key: str, members: set[Member]) -> None:
        """Refresh presence or retire an emptied room after fail-closed removals.

        ``members`` was captured before the ``await`` above. During that await another
        task may have emptied and re-created this session's set (unsubscribe of the last
        member pops the set, a fresh subscribe installs a new one). Only act when the set
        we mutated is still the room's live set; otherwise the replacement owns presence
        and retirement, and popping here would delete the newly-created room out from
        under a member that just joined.
        """
        if self.rooms.get(session_key) is not members:
            return
        if members:
            await self._emit_presence(session_key)
        else:
            self.rooms.pop(session_key, None)

    def members(self, session_key: str) -> list[Member]:
        """Every member currently connected to ``session_key``."""
        return list(self.rooms.get(session_key, ()))

    def online(self, session_key: str) -> int:
        """How many members are currently connected to ``session_key``."""
        return len(self.rooms.get(session_key, ()))

    async def _emit_presence(self, session_key: str) -> None:
        members = self.rooms.get(session_key)
        if not members:
            return
        players = [
            {"id": member.id, "name": getattr(member, "name", "") or member.id, "online": True}
            for member in members
        ]
        await self.publish(session_key, Event.presence(players, len(players)))
