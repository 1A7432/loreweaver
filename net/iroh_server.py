"""Optional Iroh (p2p QUIC) transport for the networked TUI — the DEFAULT carrier.

Same wire protocol as the WebSocket server (`docs/protocol.md`): identical JSON frames and
join handshake, only the carrier differs. Where WebSocket gives message boundaries, a QUIC
bidirectional stream is a raw byte stream, so frames are NEWLINE-DELIMITED JSON (one compact
``{...}\\n`` per frame) over one long-lived ``accept_bi`` stream.

This reuses the WS server's transport-agnostic core (`net.session.SessionCore`): keystore
auth (`resolve_session_fields`), room binding, history replay, the frame dispatch (`_on_frame`),
the per-turn choke (`dispatch_input`) and the shared `RoomHub`. An `IrohMember` only
reimplements `send_frame`/`deliver` (write a line to its QUIC `SendStream`) — so a p2p player
and a WebSocket player share one room + one AI-KP session.

`iroh` is a native dep, imported lazily in `start()`; nothing here touches it unless the Iroh
listener is actually started.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from gateway.hub import Event
from gateway.turn import publish_state
from infra.i18n import get_i18n
from net.session import SessionCore, render_frame, resolve_session_fields, welcome_frame

logger = logging.getLogger(__name__)

# The custom ALPN both ends negotiate. Bump if the framing (not the JSON protocol) changes.
ALPN = b"loreweaver/tui/1"
_READ_CHUNK = 65536
_MAX_LINE = 1 << 20  # 1 MiB guard on a single frame line (a hostile peer can't grow the buffer forever)
_DEFAULT_JOIN_TIMEOUT = 10.0


def load_or_create_secret(secret_path: Path) -> Any:
    """Load the persisted Iroh `SecretKey` from `secret_path`, creating it on first run.

    Reusing the same secret key across restarts keeps the endpoint's NodeId — and therefore
    the shareable ticket — STABLE, so a saved ticket keeps working after a server restart.

    - Missing file: generate a fresh key, persist it (best-effort `chmod 0600` — it's a
      bearer secret), and return it.
    - Corrupt/unreadable file: log a warning, regenerate + overwrite (the ticket changes
      ONCE, then is stable again). Never raises — a bad key file must self-heal, not brick
      startup.
    """
    import iroh  # lazy: native dep, only imported when Iroh is actually enabled

    if secret_path.exists():
        try:
            return iroh.SecretKey.from_bytes(secret_path.read_bytes())
        except Exception:
            logger.warning(
                "Iroh secret key file at %s is unreadable/corrupt; regenerating "
                "(the ticket will change once, then stay stable).",
                secret_path,
            )

    key = iroh.SecretKey.generate()
    try:
        secret_path.parent.mkdir(parents=True, exist_ok=True)
        secret_path.write_bytes(key.to_bytes())
        try:
            os.chmod(secret_path, 0o600)
        except OSError:
            pass  # best-effort on platforms/filesystems without POSIX perms
    except OSError:
        # A read-only / full / permission-denied data dir must NOT brick startup — under
        # systemd `Restart=on-failure` a raise here would crash-loop. Degrade to the
        # in-memory key: the server still comes up, only the ticket won't survive THIS
        # restart until the data dir is writable again. Mirrors the best-effort writes in
        # `_announce_iroh_ticket` / the keeper-key sidecar.
        logger.warning(
            "Could not persist the Iroh secret key to %s; the server will start but its "
            "ticket will change on the next restart until the data dir is writable.",
            secret_path,
        )
    return key


@dataclass(eq=False)
class IrohMember:
    """One authenticated Iroh connection, as a `gateway.hub.Member`.

    Mirrors `net.tui_server.WsMember` field-for-field so the shared session logic treats it
    identically; the only difference is `send_frame`, which writes newline-JSON to a QUIC
    `SendStream` instead of a WebSocket.
    """

    send: Any  # iroh SendStream
    id: str
    user_key: str
    name: str
    role: str
    room: str
    session_key: str
    locale: str
    transport: str = "iroh"
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def supports_proactive(self) -> bool:
        """A live QUIC stream can always be pushed to."""
        return True

    async def send_frame(self, frame: dict[str, Any]) -> None:
        """Send one protocol frame as a newline-terminated JSON line."""
        line = (json.dumps(frame, ensure_ascii=False) + "\n").encode("utf-8")
        # One writer at a time: interleaved write_all on a QUIC stream would corrupt framing.
        async with self._lock:
            try:
                await self.send.write_all(line)
            except Exception:
                pass  # peer gone / stream reset — dropped like a closed socket

    async def deliver(self, event: Event) -> None:
        frame = render_frame(event)
        if frame is not None:
            await self.send_frame(frame)


class _LineReader:
    """Buffers a QUIC `RecvStream` into newline-delimited frames."""

    def __init__(self, recv: Any) -> None:
        self._recv = recv
        self._buf = bytearray()

    async def readline(self) -> bytes | None:
        """Next `\\n`-terminated line (without the newline), or None at end of stream."""
        while True:
            nl = self._buf.find(b"\n")
            if nl >= 0:
                line = bytes(self._buf[:nl])
                del self._buf[: nl + 1]
                return line
            if len(self._buf) > _MAX_LINE:
                raise ValueError("iroh frame line exceeds cap")
            try:
                chunk = await self._recv.read(_READ_CHUNK)
            except Exception:
                chunk = None
            if not chunk:
                return None  # EOF / reset
            self._buf.extend(bytes(chunk))


def _parse_line(line: bytes) -> dict[str, Any] | None:
    try:
        data = json.loads(line)
    except (json.JSONDecodeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


async def _write_line(send: Any, frame: dict[str, Any]) -> None:
    try:
        await send.write_all((json.dumps(frame, ensure_ascii=False) + "\n").encode("utf-8"))
    except Exception:
        pass


class IrohServer:
    """Runs the Iroh (p2p) listener over the SAME SessionCore as the WS server.

    Composition, not inheritance: it borrows the core's keystore/hub/services and its
    transport-agnostic methods (`_replay_history`/`_on_frame`/`dispatch_input`/`_ctx_for`),
    so the WS server stays untouched and both wires fan out through one `RoomHub`.
    """

    def __init__(self, core: SessionCore, *, secret_path: Path | None = None) -> None:
        self.core = core
        self._secret_path = secret_path
        self._endpoint: Any = None
        self._tasks: set[asyncio.Task[Any]] = set()

    async def start(self) -> str:
        """Bind the endpoint, wait for a home relay, and return the shareable ticket string.

        When `secret_path` was given, reuse (or create) a persisted secret key so the NodeId
        — and therefore the ticket — is stable across restarts. Otherwise (loopback/tests),
        bind with an ephemeral, randomly generated key, as before.
        """
        import iroh  # lazy: native dep, only imported when Iroh is actually enabled

        if self._secret_path is not None:
            secret_key = load_or_create_secret(self._secret_path)
            # `EndpointOptions.secret_key` is a uniffi-generated `Optional[bytes]` field (see
            # its FFI type stub) despite `SecretKey.generate()`/`load_or_create_secret`
            # returning a `SecretKey` object -- passing the object itself type-checks at
            # `EndpointOptions(...)` construction (uniffi validates lazily) but raises
            # `TypeError: a bytes-like object is required, not 'SecretKey'` inside
            # `Endpoint.bind()`. Serialize it the same way it's persisted to disk.
            options = iroh.EndpointOptions(preset=iroh.preset_n0(), alpns=[ALPN], secret_key=secret_key.to_bytes())
        else:
            options = iroh.EndpointOptions(preset=iroh.preset_n0(), alpns=[ALPN])
        self._endpoint = await iroh.Endpoint.bind(options)
        await self._endpoint.online()
        return str(iroh.EndpointTicket.from_addr(self._endpoint.addr()))

    async def serve(self) -> None:
        """Accept connections until the endpoint is closed (call `start()` first)."""
        assert self._endpoint is not None, "call start() before serve()"
        while True:
            try:
                incoming = await self._endpoint.accept_next()
            except Exception:
                break
            if incoming is None:
                break
            task = asyncio.create_task(self._handle(incoming))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def _handle(self, incoming: Any) -> None:
        core = self.core
        try:
            accepting = await incoming.accept()
            conn = await accepting.connect()
            bi = await conn.accept_bi()
        except Exception:
            return
        send = bi.send()
        reader = _LineReader(bi.recv())

        member = await self._authenticate(reader, send)
        if member is None:
            return
        await core.hub.subscribe(member.session_key, member)
        try:
            await core._replay_history(member)
            await publish_state(core.hub, core.services, core._ctx_for(member))
            while True:
                line = await reader.readline()
                if line is None:
                    break
                await core._on_frame(member, line)
        finally:
            await core.hub.unsubscribe(member)

    async def _authenticate(self, reader: _LineReader, send: Any) -> IrohMember | None:
        """Consume the mandatory first `join` line; `welcome` + return an `IrohMember` on
        success, best-effort `error` + drop on failure. Mirrors the WS _authenticate."""
        i18n = get_i18n(self.core.services.settings.locale)
        timeout = getattr(self.core, "join_timeout", _DEFAULT_JOIN_TIMEOUT) or _DEFAULT_JOIN_TIMEOUT
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=timeout)
        except Exception:
            return None
        if line is None:
            return None

        frame = _parse_line(line)
        if frame is None or frame.get("type") != "join":
            await _write_line(send, {"type": "error", "code": "bad_frame", "message": i18n.t("tui.error.bad_frame")})
            return None

        key = str(frame.get("key") or "")
        fields = resolve_session_fields(self.core.keystore, key, i18n.locale)
        if fields is None:
            await _write_line(send, {"type": "error", "code": "bad_key", "message": i18n.t("tui.error.bad_key")})
            return None

        member = IrohMember(send=send, **fields)
        await member.send_frame(welcome_frame(fields))
        return member

    async def close(self) -> None:
        """Cancel in-flight per-connection tasks, then close the endpoint. Best-effort and
        idempotent — safe to call more than once (e.g. once from a signal handler's stop
        path and once from an outer `finally`)."""
        for task in list(self._tasks):
            task.cancel()
        if self._endpoint is not None:
            endpoint, self._endpoint = self._endpoint, None
            try:
                endpoint.close()
            except Exception:
                pass
