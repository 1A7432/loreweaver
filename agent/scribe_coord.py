"""Per-room Scribe coordinator: one ordered chain, lifecycle cancel, snapshot refresh.

The post-turn Scribe is fire-and-forget so the just-finished reply can leave the
room without waiting on a bookkeeping model call. That latency hide is load-bearing
and stays — and it is why the NEXT turn does not wait for it either: making turn
N+1 park on turn N's Scribe (plus its Director call and its image) would move all
of that latency back onto the table, one turn later. What fire-and-forget must not
also hide is *order*:

- two same-room passes scheduled while the previous LLM is still out can finish
  out of wall-clock order and write the earlier turn's trackers over the later one;
- ``.undo`` / ``.reset`` / import / delete / ``.save load`` could restore or wipe
  the room under a running pass, which then wrote the abandoned state back;
- ``run_kp_turn`` photographed the room *before* the pass, so a successful
  Scribe/Director write sat in no turn-boundary snapshot.

This module is the single in-process owner of that chain. It lives in ``agent/``
so the keeper-lane prompt site (``agent.loop``) and the undo restore can call it
without a gateway/net reverse import. The two operations have two homes, not a
copy in every command:

- **schedule** — ``gateway.turn`` after a player turn's reply has already streamed;
- **cancel-and-drain** — ``agent.undo.restore`` and the four ``net.room_backup``
  mutations, *before* they touch documents or room_state.

Companion sub-turns re-enter the turn flow inside the same player turn, and the
player's pass already sees the whole exchange. They *do* advance the chronicle
counter, which is why a completed pass refreshes the snapshot named by the
*current* counter, never the player turn's ``result.turn`` — and why it stands
down when that counter has moved past the turn it was scheduled on: a newer turn
owns that boundary now.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from infra.room_facets import STORAGE_MEMORY, FacetContext, RoomStateFacet

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ScribeEpoch:
    """What a scheduled pass captured about the room at enqueue time.

    ``cancel_gen`` changes when a destructive lifecycle cancels the chain —
    a queued pass whose generation no longer matches must not start writing.
    ``chronicle_turn`` is the room's completed-turn counter as it stood when the
    pass was scheduled — a pass that finishes after the counter has advanced must
    not refresh a boundary a newer turn already owns.
    ``transcript_leaf`` is the history message the scheduling turn ENDED on (its
    reply, or the last companion exchange inside it) — where anything the pass puts
    in front of the table (the Stage Director's staging) anchors in the join-replay
    lane. Read when the pass runs, the leaf would be the NEXT turn's player line
    whenever the pass is late, and the staging would replay inside a turn it does
    not belong to. ``None`` = not captured (a hand-built epoch).
    """

    cancel_gen: int
    chronicle_turn: int
    transcript_leaf: str | None = None


@dataclass
class _RoomScribe:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    tasks: set[asyncio.Task[None]] = field(default_factory=set)
    cancel_gen: int = 0


class ScribeRuntime:
    """Process-wide, per-room Scribe chain. One instance; tests call ``dispose``."""

    def __init__(self) -> None:
        self._rooms: dict[str, _RoomScribe] = {}

    def tracked(self, chat_key: str) -> bool:
        """True while this process is holding coordinator memory for ``chat_key``."""
        return chat_key in self._rooms

    def cancel_generation(self, chat_key: str) -> int:
        """The room's current cancel generation, opening the room's slot if it is new.

        Opening it HERE — at epoch capture, not only at ``schedule`` — is what makes
        the stamp comparable later: a slot that did not exist yet would read as "the
        chain was disposed" when the finished pass asks whether it may still write.
        """
        return self._ensure(chat_key).cancel_gen

    def may_refresh_snapshot(self, chat_key: str, epoch: ScribeEpoch | None) -> bool:
        """False when the chain this pass belongs to has been cancelled since.

        ``epoch is None`` is the standalone/CLI path: that caller awaits the pass
        inline, so nothing can have cancelled it out from under itself.
        """
        if epoch is None:
            return True
        state = self._rooms.get(chat_key)
        if state is None:
            return False
        return state.cancel_gen == epoch.cancel_gen

    def schedule(self, chat_key: str, factory: Callable[[], Awaitable[None]]) -> asyncio.Task[None]:
        """Enqueue one pass behind any in-flight pass for this room. Returns at once.

        The caller must not await the returned task on the turn that produced it —
        that would put the bookkeeping latency back on the visible reply. No later
        turn awaits it either; the chain only guarantees ORDER, never that the
        table waits for it.
        """
        state = self._ensure(chat_key)
        cancel_gen = state.cancel_gen

        async def _run() -> None:
            async with state.lock:
                if state.cancel_gen != cancel_gen:
                    return
                await factory()

        task = asyncio.create_task(_run(), name=f"scribe:{chat_key}")
        state.tasks.add(task)
        task.add_done_callback(state.tasks.discard)
        return task

    async def await_idle(self, chat_key: str) -> None:
        """Wait until this room's chain has no running pass. Does not cancel.

        Tests and the playtest drain; no turn path calls it. Shields the underlying
        tasks so a cancelled waiter cannot take the bookkeeping pass down with it.
        """
        while True:
            state = self._rooms.get(chat_key)
            if state is None:
                return
            pending = [task for task in state.tasks if not task.done()]
            if not pending:
                return
            await asyncio.gather(*(asyncio.shield(task) for task in pending), return_exceptions=True)

    async def await_all(self) -> None:
        """Wait until every room's chain is idle. Tests and the playtest drain."""
        for chat_key in list(self._rooms):
            await self.await_idle(chat_key)

    async def cancel_and_drain(self, chat_key: str) -> None:
        """Abort the chain and wait for every task to settle. Idempotent.

        A destructive lifecycle calls this *before* it mutates, so a cancelled
        pass cannot write the abandoned room back. ``CancelledError`` is left
        to propagate out of the pass; it is not wrapped as a logged failure.
        """
        state = self._rooms.get(chat_key)
        if state is None:
            return
        state.cancel_gen += 1
        pending = [task for task in state.tasks if not task.done()]
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    async def dispose(self, chat_key: str) -> None:
        """Cancel, drain, and drop the in-process slot. Room delete / ``.reset all``."""
        await self.cancel_and_drain(chat_key)
        self._rooms.pop(chat_key, None)

    async def quiesce(self, chat_key: str, *, dispose: bool = False) -> None:
        """The room-lifecycle entry: cancel-and-drain, optionally forget the slot."""
        if dispose:
            await self.dispose(chat_key)
            return
        await self.cancel_and_drain(chat_key)

    async def reset_for_tests(self) -> None:
        """Drop every room this process is tracking. Tests only."""
        for chat_key in list(self._rooms):
            await self.dispose(chat_key)

    def _ensure(self, chat_key: str) -> _RoomScribe:
        state = self._rooms.get(chat_key)
        if state is None:
            state = _RoomScribe()
            self._rooms[chat_key] = state
        return state


scribe_runtime = ScribeRuntime()


async def capture_epoch(services: Any, chat_key: str) -> ScribeEpoch:
    """What the pass being scheduled right now must remember about the room.

    Called by `gateway.turn.run_turn` as it schedules the pass, while the transport
    still holds the room's turn lock — so every field is that turn's own, and nothing
    a later turn writes can be read into it.
    """
    from agent.chronicle import chronicle_turn
    from agent.history import current_leaf

    return ScribeEpoch(
        cancel_gen=scribe_runtime.cancel_generation(chat_key),
        chronicle_turn=await chronicle_turn(services.store, chat_key),
        transcript_leaf=await current_leaf(services, chat_key),
    )


async def refresh_latest_snapshot(services: Any, chat_key: str, *, epoch: ScribeEpoch | None = None) -> None:
    """Recapture the newest turn-boundary snapshot, if this pass still owns it.

    Reads the room's current chronicle counter rather than the player turn's
    ``result.turn``. Companion sub-turns advance that counter and have already
    photographed their own boundaries; writing the player's earlier index would
    fold their state (and this pass's writes) into the wrong snapshot.

    Two ways a pass loses ownership: a destructive lifecycle cancelled the chain
    (``may_refresh_snapshot``), or the counter has moved PAST the turn this pass
    was scheduled on — a newer turn photographed that boundary already, and this
    pass's older view of the room must not be written over it.
    """
    if not scribe_runtime.may_refresh_snapshot(chat_key, epoch):
        return
    from agent.chronicle import chronicle_turn
    from agent.undo import capture as capture_snapshot

    turn = await chronicle_turn(services.store, chat_key)
    if turn <= 0:
        return
    if epoch is not None and turn > epoch.chronicle_turn:
        return
    if not scribe_runtime.may_refresh_snapshot(chat_key, epoch):
        return
    await capture_snapshot(services, chat_key, turn)


async def _dispose_scribe_chain(ctx: FacetContext) -> None:
    await scribe_runtime.dispose(ctx.chat_key)


# --- Room lifecycle (M23 WS1) -----------------------------------------------
ROOM_FACETS = (
    RoomStateFacet(
        name="scribe_chain",
        owner="agent.scribe_coord",
        reset_scope="all",
        export_exempt_because="process state — there are no rows to carry",
        storages=frozenset({STORAGE_MEMORY}),
        on_delete=_dispose_scribe_chain,
        on_reset=_dispose_scribe_chain,
    ),
)
