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
import inspect
import json
import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from gateway.hub import Event
from gateway.turn import publish_state
from infra.file_permissions import atomic_write_private, ensure_private_directory, restrict_file
from infra.i18n import get_i18n
from infra.media_store import MediaError
from net.session import SessionCore, guided_demo_available, render_frame, resolve_session_fields, welcome_frame

logger = logging.getLogger(__name__)

# The custom ALPN both ends negotiate. Bump if the framing (not the JSON protocol) changes.
ALPN = b"loreweaver/tui/1"
_READ_CHUNK = 65536
_MAX_LINE = 1 << 20  # 1 MiB guard on a single frame line (a hostile peer can't grow the buffer forever)
_DEFAULT_JOIN_TIMEOUT = 10.0


def load_or_create_secret(secret_path: Path) -> Any:
    """Load the persisted Iroh `SecretKey` from `secret_path`, creating it on first run.

    Reusing the same secret key across restarts keeps the endpoint's NodeId STABLE; together
    with the remembered UDP port (`IrohServer._bind_endpoint`) the whole shareable ticket is,
    so a saved ticket keeps working -- directly, not only via the relay -- after a restart.

    - Missing file: generate a fresh key, persist it (best-effort `chmod 0600` — it's a
      bearer secret), and return it.
    - Corrupt/unreadable file: log a warning, regenerate + overwrite (the ticket changes
      ONCE, then is stable again). Never raises — a bad key file must self-heal, not brick
      startup.
    """
    import iroh  # lazy: native dep, only imported when Iroh is actually enabled

    if secret_path.exists():
        restrict_file(secret_path)
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
        ensure_private_directory(secret_path.parent, tighten_existing=False)
        atomic_write_private(secret_path, key.to_bytes())
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


# The direct-address port (see `IrohServer.start`). Remembered next to the secret key so the
# ticket's direct addresses -- not just its NodeId -- survive a restart.
PORT_SIDECAR_NAME = "iroh-port.txt"


def port_sidecar_path(secret_path: Path) -> Path:
    """Where the remembered UDP port lives: beside the secret key, in the keys directory."""
    return secret_path.with_name(PORT_SIDECAR_NAME)


def _valid_port(value: Any) -> int:
    """`value` as a usable UDP port (1-65535), else 0 ("none")."""
    try:
        port = int(value)
    except (TypeError, ValueError):
        return 0
    return port if 1 <= port <= 65535 else 0


def read_remembered_port(sidecar: Path) -> int:
    """The port saved in `sidecar`, or 0 when it is missing/unreadable/not a port.

    A damaged sidecar is not an error: it reads as "nothing remembered" and the next
    successful bind overwrites it."""
    try:
        return _valid_port(sidecar.read_text(encoding="utf-8").strip())
    except (OSError, UnicodeDecodeError):
        return 0


def write_remembered_port(sidecar: Path, port: int) -> bool:
    """Persist `port` (best-effort, like the secret key: a read-only data dir must not brick
    startup under `Restart=on-failure`). Returns whether the write landed."""
    try:
        atomic_write_private(sidecar, f"{port}\n")
    except OSError:
        logger.warning(
            "Could not persist the Iroh UDP port to %s; the ticket's direct addresses will "
            "change on the next restart until the data dir is writable again.",
            sidecar,
        )
        return False
    return True


def ipv4_port(bound_sockets: Iterable[str]) -> int:
    """The port of the first IPv4 socket in `Endpoint.bound_sockets()` (``"0.0.0.0:50264"``,
    ``"[::]:58702"``), or 0 if there is none. IPv6 entries are skipped on purpose: only the
    IPv4 socket is pinned (see `IrohServer._bind_endpoint`)."""
    for sock in bound_sockets:
        host, _, port = str(sock).rpartition(":")
        if host and ":" not in host:
            return _valid_port(port)
    return 0


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
    # QUIC connection; closed on handshake failure and live-authorization revoke (WS `ws.close()`).
    conn: Any = None
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    authorize: Callable[[], bool] | None = None
    # See `net.tui_server.WsMember.held_events`: live events held during join replay.
    held_events: list[Event] | None = None

    async def send_frame(self, frame: dict[str, Any]) -> None:
        """Send one protocol frame as a newline-terminated JSON line."""
        line = (json.dumps(frame, ensure_ascii=False) + "\n").encode("utf-8")
        # One writer at a time: interleaved write_all on a QUIC stream would corrupt framing.
        async with self._lock:
            try:
                await self.send.write_all(line)
            except Exception:
                # Swallow: matches WS `_send`. Raising here would make every hub publish drop
                # the member (RoomHub drops on `deliver` raise) — a broader policy than this
                # lifecycle fix. Handshake writes go through `_write_line`, which reports failure.
                pass

    async def deliver(self, event: Event) -> None:
        if self.held_events is not None:
            self.held_events.append(event)
            return
        if self.authorize is not None and not self.authorize():
            await self.send_frame(
                {
                    "type": "error",
                    "code": "forbidden",
                    "message": get_i18n(self.locale).t("tui.error.forbidden"),
                }
            )
            await _close_transport(self.conn, self.send)
            raise PermissionError("member authorization was revoked")  # i18n-exempt: internal hub signal
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

    async def read_exact(self, size: int) -> bytes:
        """Read exactly `size` bytes after a header line, preserving buffered bytes."""
        remaining = size
        out = bytearray()
        if self._buf:
            take = min(remaining, len(self._buf))
            out.extend(self._buf[:take])
            del self._buf[:take]
            remaining -= take
        while remaining > 0:
            chunk = await self._recv.read(min(_READ_CHUNK, remaining))
            if not chunk:
                raise EOFError("media_body_incomplete")
            data = bytes(chunk)
            if len(data) > remaining:
                out.extend(data[:remaining])
                self._buf.extend(data[remaining:])
                remaining = 0
            else:
                out.extend(data)
                remaining -= len(data)
        return bytes(out)


def _parse_line(line: bytes) -> dict[str, Any] | None:
    try:
        data = json.loads(line)
    except (json.JSONDecodeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


async def _await_maybe(value: Any) -> None:
    if inspect.isawaitable(value):
        await value


async def _write_line(send: Any, frame: dict[str, Any]) -> bool:
    """Write one newline-JSON frame. Returns False if the stream is gone.

    Handshake uses the return value so it can still close the QUIC connection
    after a failed write. Post-join media errors stay best-effort (ignore the bool).
    """
    try:
        await send.write_all((json.dumps(frame, ensure_ascii=False) + "\n").encode("utf-8"))
    except Exception:
        return False
    return True


_FINISH_TIMEOUT = 0.5


async def _close_transport(conn: Any, send: Any | None = None) -> None:
    """Best-effort finish of the control stream, then close the QUIC connection.

    Handshake-failure / live-authorization-revoke / handle-exit only. Post-join
    recoverable errors (`rate_limited`, `bad_frame` after join, …) stay on the
    live stream — `docs/protocol.md` closes only on join-handshake fatals.

    Real iroh: `SendStream.finish()` is async; `Connection.close(error_code, reason)`
    is sync. Fakes may omit args or return an awaitable; both shapes are accepted.
    `CancelledError` during finish still closes the connection, then re-raises
    the saved exception (a bare `raise` here is no longer in an active `except`
    and would become `RuntimeError: No active exception to reraise`).
    """
    cancelled_exc: BaseException | None = None
    if send is not None:
        finish = getattr(send, "finish", None)
        if finish is not None:
            try:
                await asyncio.wait_for(_await_maybe(finish()), timeout=_FINISH_TIMEOUT)
            except asyncio.CancelledError as exc:
                cancelled_exc = exc
            except Exception:
                pass
    if conn is not None:
        closer = getattr(conn, "close", None)
        if closer is not None:
            try:
                try:
                    result = closer(0, b"")
                except TypeError:
                    result = closer()
                await _await_maybe(result)
            except asyncio.CancelledError as exc:
                cancelled_exc = exc
            except Exception:
                pass
    if cancelled_exc is not None:
        raise cancelled_exc


async def _write_bytes_chunked(send: Any, data: bytes, chunk_size: int = _READ_CHUNK) -> None:
    for offset in range(0, len(data), chunk_size):
        await send.write_all(data[offset : offset + chunk_size])


class IrohServer:
    """Runs the Iroh (p2p) listener over the SAME SessionCore as the WS server.

    Composition, not inheritance: it borrows the core's keystore/hub/services and its
    transport-agnostic methods (`_replay_history`/`_on_frame`/`dispatch_input`/`_ctx_for`),
    so the WS server stays untouched and both wires fan out through one `RoomHub`.
    """

    def __init__(self, core: SessionCore, *, secret_path: Path | None = None, port: int = 0) -> None:
        """`port` is the operator's explicit UDP port (`TRPG_TUI__IROH_PORT`; 0 = remembered/auto).
        It only matters with a `secret_path`; loopback/test servers bind as they always did."""
        self.core = core
        self._secret_path = secret_path
        self._port_override = port
        self._endpoint: Any = None
        self._tasks: set[asyncio.Task[Any]] = set()
        # Filled by `start()` for the banner: the IPv4 port actually bound (0 = unknown / not
        # pinned) and, when the wanted port was unavailable, the port we had to give up on.
        self.direct_port = 0
        self.port_changed_from = 0

    async def start(self) -> str:
        """Bind the endpoint, wait for a home relay, and return the shareable ticket string.

        When `secret_path` was given, reuse (or create) a persisted secret key so the NodeId
        is stable across restarts, and pin the UDP port the same way (`_bind_endpoint`) so the
        ticket's direct addresses are stable too. Otherwise (loopback/tests), bind with an
        ephemeral, randomly generated key on a random port, as before.
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
            self._endpoint = await self._bind_endpoint(iroh, secret_key.to_bytes(), self._secret_path)
        else:
            self._endpoint = await iroh.Endpoint.bind(iroh.EndpointOptions(preset=iroh.preset_n0(), alpns=[ALPN]))
        await self._endpoint.online()
        return str(iroh.EndpointTicket.from_addr(self._endpoint.addr()))

    async def _bind_endpoint(self, iroh: Any, secret_key: bytes, secret_path: Path) -> Any:
        """Bind on a UDP port that survives restarts, so a saved ticket stays directly dialable.

        The secret key fixes the NodeId, but a ticket also carries the server's DIRECT addresses
        (LAN/public IP + port); with a random port per start every one of them is dead after a
        restart and a returning client can only reach us through the relay (30-70 s from far
        away). So the port is remembered in a sidecar next to the key:

        - wanted port = `TRPG_TUI__IROH_PORT` (operator pin, wins) else the sidecar;
        - first start (nothing wanted): bind a random port, then read back what we got and
          save it;
        - the wanted port is unavailable (in use, no permission): bind a random port instead,
          log that the ticket changes this time, and overwrite the sidecar.

        `EndpointOptions.bind_addr` is ONE ``host:port`` string and pins only the socket family
        of that address: ``"0.0.0.0:P"`` fixes the IPv4 socket, while the IPv6 socket
        (``[::]:*``) keeps a random port on every start -- verified against the iroh 1.1 binding
        (``Endpoint.bound_sockets()`` shows both). The IPv4 addresses (LAN + public) are the
        ones that matter for a returning client, so that is what we pin; IPv6 direct addresses
        in an old ticket simply fail fast and the IPv4/relay paths carry the connection.
        """
        sidecar = port_sidecar_path(secret_path)
        remembered = read_remembered_port(sidecar)
        override = _valid_port(self._port_override)
        if self._port_override and not override:
            logger.warning(
                "TRPG_TUI__IROH_PORT=%r is not a UDP port (1-65535); ignoring it.", self._port_override
            )
        wanted = override or remembered

        base: dict[str, Any] = {"preset": iroh.preset_n0(), "alpns": [ALPN], "secret_key": secret_key}
        endpoint: Any = None
        if wanted:
            try:
                endpoint = await iroh.Endpoint.bind(iroh.EndpointOptions(**base, bind_addr=f"0.0.0.0:{wanted}"))
            except Exception as exc:
                logger.warning(
                    "Could not bind the %s UDP port %d (%r); falling back to a random port. "
                    "The direct addresses in the Iroh ticket change THIS time, so saved tickets "
                    "reach the server only through the relay until they are replaced.",
                    "pinned" if override else "remembered",
                    wanted,
                    exc,
                )
                self.port_changed_from = wanted
        if endpoint is None:
            endpoint = await iroh.Endpoint.bind(iroh.EndpointOptions(**base))

        try:
            self.direct_port = ipv4_port(endpoint.bound_sockets())
        except Exception:
            self.direct_port = 0  # an unreadable port is "not remembered", never a startup failure
        if self.direct_port and self.direct_port != remembered:
            write_remembered_port(sidecar, self.direct_port)
        return endpoint

    async def serve(self) -> None:
        """Accept connections until the endpoint is closed (call `start()` first)."""
        assert self._endpoint is not None, "call start() before serve()"
        while True:
            endpoint = self._endpoint
            if endpoint is None:
                break
            try:
                incoming = await endpoint.accept_next()
            except asyncio.CancelledError:
                raise
            except Exception:
                break
            if incoming is None:
                break
            task = asyncio.create_task(self._handle(incoming))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def _handle(self, incoming: Any) -> None:
        core = self.core
        conn: Any = None
        send: Any = None
        try:
            try:
                accepting = await incoming.accept()
                conn = await accepting.connect()
                bi = await conn.accept_bi()
            except asyncio.CancelledError:
                raise
            except Exception:
                return
            send = bi.send()
            reader = _LineReader(bi.recv())

            member = await self._authenticate(reader, send)
            if member is None:
                return
            member.conn = conn
            if not core._refresh_member_authorization(member):
                await member.send_frame(
                    {
                        "type": "error",
                        "code": "forbidden",
                        "message": get_i18n(member.locale).t("tui.error.forbidden"),
                    }
                )
                return
            await core.hub.subscribe(member.session_key, member)
            media_task = asyncio.create_task(self._accept_media_streams(conn, member))
            try:
                await core._replay_history(member)
                await publish_state(core.hub, core.services, core._ctx_for(member))
                await core.send_ui_manifest(member)
                while True:
                    line = await reader.readline()
                    if line is None:
                        break
                    await core._on_frame(member, line)
            finally:
                media_task.cancel()
                try:
                    await media_task
                except asyncio.CancelledError:
                    pass
                core.drop_pending_media(member)
                await core.hub.unsubscribe(member)
        finally:
            # Always tear down the QUIC connection when this handler exits: handshake
            # failure, EOF, cancellation, or live-auth revoke. Post-join recoverable
            # errors stay on the stream and do not come through this path.
            await _close_transport(conn, send)

    async def _accept_media_streams(self, conn: Any, member: IrohMember) -> None:
        while True:
            try:
                bi = await conn.accept_bi()
            except asyncio.CancelledError:
                raise
            except Exception:
                return
            task = asyncio.create_task(self._handle_media_stream(member, bi))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def _handle_media_stream(self, member: IrohMember, bi: Any) -> None:
        send = bi.send()
        reader = _LineReader(bi.recv())
        i18n = get_i18n(member.locale)
        try:
            line = await reader.readline()
            header = _parse_line(line or b"")
            if header is None:
                await _write_line(send, {"type": "error", "code": "bad_frame", "message": i18n.t("tui.error.bad_frame")})
                return
            op = header.get("op")
            if op == "put":
                upload_id = str(header.get("upload_id") or "")
                pending = self.core._pending_media.get(upload_id)
                if pending is None:
                    raise MediaError("media_bad_upload")
                data = await reader.read_exact(pending.size)
                await self.core.receive_media_put(member, upload_id, data)
                await _write_line(send, {"op": "put_ok", "hash": pending.sha256})
                return
            if op == "get":
                response_header, data = await self.core.get_media_bytes(member, str(header.get("hash") or ""))
                await _write_line(send, response_header)
                await _write_bytes_chunked(send, data)
                return
            await _write_line(send, {"type": "error", "code": "bad_frame", "message": i18n.t("tui.error.bad_frame")})
        except MediaError as exc:
            await _write_line(send, {"type": "error", "code": exc.code, "message": i18n.t(f"tui.error.{exc.code}")})
        except Exception:
            await _write_line(
                send,
                {"type": "error", "code": "server_error", "message": i18n.t("tui.error.server_error")},
            )

    async def _authenticate(self, reader: _LineReader, send: Any) -> IrohMember | None:
        """Consume the mandatory first `join` line; `welcome` + return an `IrohMember` on
        success, best-effort `error` + drop on failure. Mirrors the WS _authenticate.

        `TimeoutError` (`asyncio.wait_for`; `asyncio.TimeoutError` is this alias)
        writes the promised `error{code:'join_timeout'}` then fails. `CancelledError`
        propagates (server shutdown). Other read errors fail cleanly with no frame —
        the caller closes the QUIC connection. A failed `welcome` write (`_write_line`
        returns False) also returns None so `_handle` never subscribes a half-open member.
        """
        i18n = get_i18n(self.core.services.settings.locale)
        timeout = getattr(self.core, "join_timeout", _DEFAULT_JOIN_TIMEOUT) or _DEFAULT_JOIN_TIMEOUT
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=timeout)
        except TimeoutError:
            await _write_line(
                send, {"type": "error", "code": "join_timeout", "message": i18n.t("tui.error.join_timeout")}
            )
            return None
        except asyncio.CancelledError:
            raise
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
        member.authorize = lambda: self.core._refresh_member_authorization(member)
        welcome = welcome_frame(
            fields,
            imagegen=self.core.services.imagegen is not None,
            demo=(
                fields["role"] == "keeper"
                and await guided_demo_available(self.core.services, fields["session_key"])
            ),
            can_update=(
                fields["role"] == "keeper"
                and bool(self.core.services.settings.tui.update_command)
            ),
        )
        if not await _write_line(send, welcome):
            return None
        return member

    async def _cancel_and_drain_tasks(self) -> None:
        """Cancel tracked connection/media tasks and wait for them to settle.

        Snapshot first: each task's done callback discards from `_tasks`, so iterating
        the live set while awaiting would drop references mid-drain.
        """
        tasks = list(self._tasks)
        if not tasks:
            return
        for task in tasks:
            task.cancel()
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for result in results:
            if isinstance(result, asyncio.CancelledError):
                continue
            if isinstance(result, BaseException) and not isinstance(result, Exception):
                raise result

    async def close(self) -> None:
        """Cancel and drain tracked tasks, then await `endpoint.close()`.

        Idempotent — safe to call more than once (e.g. once from a signal handler's
        stop path and once from an outer `finally`). `Endpoint.close()` is async and
        MUST be awaited; a bare call leaves a `RuntimeWarning` and the accept loop
        stuck. After the endpoint is closed, `serve()`'s `accept_next()` returns
        `None` and the accept task can exit.
        """
        try:
            await self._cancel_and_drain_tasks()
        finally:
            if self._endpoint is not None:
                endpoint, self._endpoint = self._endpoint, None
                try:
                    await _await_maybe(endpoint.close())
                except asyncio.CancelledError:
                    raise
                except Exception:
                    pass
            # A late `_handle` can spawn between the first drain and endpoint close
            # (the accept loop is still live until `endpoint.close()` returns).
            await self._cancel_and_drain_tasks()
