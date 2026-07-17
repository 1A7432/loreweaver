"""QQ Gateway lifecycle: heartbeat, resume, and reconnect supervision."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from contextlib import suppress
from typing import Any

logger = logging.getLogger(__name__)

DISPATCH = 0
HEARTBEAT = 1
IDENTIFY = 2
RESUME = 6
RECONNECT = 7
INVALID_SESSION = 9
HELLO = 10
HEARTBEAT_ACK = 11

PayloadHandler = Callable[[dict[str, Any]], Awaitable[None]]
Sleep = Callable[[float], Awaitable[None]]


class QQGateway:
    """Run one QQ websocket at a time and resume it after transient failures."""

    def __init__(
        self,
        transport: Any,
        on_dispatch: PayloadHandler,
        *,
        intents: int,
        sleep: Sleep = asyncio.sleep,
        retry_min: float = 1.0,
        retry_max: float = 30.0,
    ) -> None:
        self.transport = transport
        self.on_dispatch = on_dispatch
        self.intents = intents
        self._sleep = sleep
        self._retry_min = retry_min
        self._retry_max = retry_max
        self._retry_delay = retry_min
        self._task: asyncio.Task[None] | None = None
        self._heartbeat_task: asyncio.Task[None] | None = None
        self._business_task: asyncio.Task[None] | None = None
        self._business_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._closing = False
        self._ready = asyncio.Event()
        self._heartbeat_acked = True

        self.session_id: str | None = None
        self.sequence: int | None = None

    async def wait_ready(self, timeout: float) -> None:
        """Block until the first READY/RESUMED after start(); raises TimeoutError."""
        await asyncio.wait_for(self._ready.wait(), timeout)

    async def start(self) -> None:
        if self._task is None or self._task.done():
            self._closing = False
            self._task = asyncio.create_task(self._supervise())

    async def stop(self) -> None:
        self._closing = True
        await self._stop_heartbeat()
        if self._business_task is not None:
            self._business_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._business_task
            self._business_task = None
        self._discard_business_queue()
        if self._task is not None:
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        await self.transport.close()

    async def _supervise(self) -> None:
        while not self._closing:
            try:
                await self.transport.ws(self.dispatch_payload)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("qq.gateway_connection_failed", exc_info=True)
            finally:
                self._ready.clear()
                await self._stop_heartbeat()

            if self._closing:
                return
            delay = self._retry_delay
            self._retry_delay = min(self._retry_delay * 2, self._retry_max)
            await self._sleep(delay)

    async def dispatch_payload(self, payload: dict[str, Any]) -> None:
        sequence = payload.get("s")
        if isinstance(sequence, int):
            self.sequence = sequence

        op = payload.get("op")
        data = payload.get("d")
        if op == HELLO:
            interval_ms = int(data.get("heartbeat_interval") or 0) if isinstance(data, dict) else 0
            if interval_ms <= 0:
                raise RuntimeError("qq.gateway.bad_heartbeat_interval")
            await self._start_heartbeat(interval_ms / 1000)
            await self._authenticate()
            return
        if op == HEARTBEAT_ACK:
            self._heartbeat_acked = True
            return
        if op == RECONNECT:
            await self.transport.close_ws()
            return
        if op == INVALID_SESSION:
            if data is not True:
                self.session_id = None
                self.sequence = None
            await self.transport.close_ws()
            return
        if op != DISPATCH:
            return

        event_type = str(payload.get("t") or "")
        if event_type == "READY":
            if isinstance(data, dict):
                self.session_id = str(data.get("session_id") or "") or None
            self._retry_delay = self._retry_min
            self._ready.set()
            return
        elif event_type == "RESUMED":
            self._retry_delay = self._retry_min
            self._ready.set()
            return

        if self._business_task is None or self._business_task.done():
            self._business_task = asyncio.create_task(self._consume_dispatches())
        self._business_queue.put_nowait(payload)

    async def wait_idle(self) -> None:
        """Wait until queued business events finish; useful for clean tests/shutdowns."""
        await self._business_queue.join()

    async def _consume_dispatches(self) -> None:
        while True:
            payload = await self._business_queue.get()
            try:
                await self.on_dispatch(payload)
            except Exception:
                logger.warning("qq.dispatch_failed event=%s", payload.get("t"), exc_info=True)
            finally:
                self._business_queue.task_done()

    def _discard_business_queue(self) -> None:
        while True:
            try:
                self._business_queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            self._business_queue.task_done()

    async def _authenticate(self) -> None:
        token = await self.transport.token()
        if self.session_id and self.sequence is not None:
            payload = {
                "op": RESUME,
                "d": {"token": f"QQBot {token}", "session_id": self.session_id, "seq": self.sequence},
            }
        else:
            payload = {
                "op": IDENTIFY,
                "d": {
                    "token": f"QQBot {token}",
                    "intents": self.intents,
                    "shard": [0, 1],
                    "properties": {
                        "$os": "python",
                        "$browser": "loreweaver",
                        "$device": "loreweaver",
                    },
                },
            }
        await self.transport.send_ws(payload)

    async def _start_heartbeat(self, interval: float) -> None:
        await self._stop_heartbeat()
        self._heartbeat_acked = True
        self._heartbeat_task = asyncio.create_task(self._heartbeat(interval))

    async def _stop_heartbeat(self) -> None:
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._heartbeat_task
            self._heartbeat_task = None

    async def _heartbeat(self, interval: float) -> None:
        while True:
            await self._sleep(interval)
            if not self._heartbeat_acked:
                # The previous HEARTBEAT was never ACKed: the socket is a
                # zombie (open but deaf). Close it so _supervise reconnects.
                logger.warning("qq.heartbeat_ack_missed")
                await self.transport.close_ws()
                return
            self._heartbeat_acked = False
            try:
                await self.transport.send_ws({"op": HEARTBEAT, "d": self.sequence})
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("qq.heartbeat_failed", exc_info=True)
                await self.transport.close_ws()
                return
