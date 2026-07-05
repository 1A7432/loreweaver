"""The M4 networked-TUI WebSocket server — see `docs/protocol.md` for the
wire protocol this implements.

As of M6 the server no longer owns its own room bookkeeping: it runs on a
shared `gateway.hub.RoomHub`. Each authenticated connection becomes a
`WsMember` (a `gateway.hub.Member` on `transport="tui"`) whose `deliver`
renders a normalized `gateway.hub.Event` into the existing WS JSON frame and
sends it over the socket. A player's input is handed to the transport-agnostic
`gateway.turn.run_turn`, which publishes the turn's events to the room; the
hub fans them out to every member — so the exact same turn now reaches a
second terminal (or, later, a Discord/QQ member) in the same session. The wire
protocol, `--serve`/`--tui-key` and `keys.example.toml` are unchanged.

On `join`, after `welcome`, a newly connected (or reconnecting) member also
gets a one-time REPLAY of the room's recent narrative -- `narrative` frames
sent to that connection ONLY (never broadcast) -- so it does not see an empty
log while the KP session keeps continuing from server-side history. See
`TuiServer._replay_history`.
"""

from __future__ import annotations

import asyncio
import json
import ssl
from dataclasses import dataclass
from typing import Any

import websockets
from websockets.exceptions import ConnectionClosed

from agent.context import FsAdapter
from agent.services import Services
from agent.tools import Toolset
from gateway.commands import CommandRouter
from gateway.hub import Event, RoomHub
from gateway.ops import Censor
from gateway.turn import publish_state
from infra.config import Settings
from infra.i18n import get_i18n
from infra.media_store import MediaError
from net.keystore import Keystore

# The transport-neutral session core + frame helpers now live in `net.session`; the WebSocket
# server just adds the WS accept loop + `WsMember`. The underscore aliases keep the historical
# `from net.tui_server import ...` imports (`net.iroh_server`, `_authenticate`) working unchanged.
from net.session import SessionCore, resolve_session_fields, welcome_frame
from net.session import error_frame as _error_frame
from net.session import parse_frame as _parse_frame
from net.session import render_frame as _render_frame

_WS_MEDIA_HEADER_BYTES = 4
# Headroom over the largest allowed media body for the length prefix + JSON header of one
# binary media message (a PUT is ONE WebSocket message on this carrier).
_WS_MEDIA_HEADER_SLACK = 64 * 1024


@dataclass(eq=False)
class WsMember:
    """One authenticated WebSocket connection, as a `gateway.hub.Member`.

    Identity/equality is by object identity (`eq=False`) so two distinct
    connections from the same key/name can both sit in a room's `set`, and so
    the member is hashable for the hub's `set[Member]`. `deliver` is the
    terminal renderer: it turns a normalized :class:`~gateway.hub.Event` into
    the existing WS JSON frame and sends it over this connection's socket.
    """

    ws: Any
    id: str
    user_key: str
    name: str
    role: str
    room: str
    session_key: str
    locale: str
    transport: str = "tui"

    def supports_proactive(self) -> bool:
        """A live terminal can always be pushed to (it is a persistent socket)."""
        return True

    async def send_frame(self, frame: dict[str, Any]) -> None:
        """Send one already-built protocol frame over this connection.

        The transport hook the shared session logic (`_on_frame`, `dispatch_input`,
        `_replay_history`) sends through, so those stay transport-agnostic — a second
        transport (`net.iroh_server.IrohMember`) only reimplements this + `deliver`.
        """
        await _send(self.ws, frame)

    async def send_media(self, header: dict[str, Any], data: bytes = b"") -> None:
        await _send_media(self.ws, header, data)

    async def deliver(self, event: Event) -> None:
        """Render `event` to its WS frame and send it (dropping a closed socket)."""
        frame = _render_frame(event)
        if frame is not None:
            await self.send_frame(frame)


class TuiServer(SessionCore):
    """The WebSocket transport for the networked TUI: a `websockets` accept loop over the shared
    `SessionCore` (one `gateway.hub.RoomHub`), each authenticated socket a `WsMember`. Kept as the
    zero-config LOCAL / loopback / offline-test carrier; `net.iroh_server` is the default p2p
    transport for reaching remote hosts. Both drive the same `SessionCore`, so they share a room."""

    def __init__(
        self,
        services: Services,
        keystore: Keystore,
        *,
        host: str = "127.0.0.1",
        port: int = 8787,
        command_router: CommandRouter | None = None,
        toolset: Toolset | None = None,
        censor: Censor | None = None,
        hub: RoomHub | None = None,
        fs: FsAdapter | None = None,
        join_timeout: float | None = None,
        max_connections: int | None = None,
    ) -> None:
        super().__init__(
            services,
            keystore,
            command_router=command_router,
            toolset=toolset,
            censor=censor,
            hub=hub,
            fs=fs,
            join_timeout=join_timeout,
        )
        self.host = host
        self.port = port
        self._server: Any = None
        # Availability hardening (`infra.config.TuiSettings`): overridable for tests, else settings.
        self.max_connections = (
            services.settings.tui.max_connections if max_connections is None else max_connections
        )
        self._active_connections = 0

    @property
    def bound_port(self) -> int:
        """The actual listening port (resolves an ephemeral `port=0` once `start()` has run)."""
        if self._server is not None:
            return self._server.sockets[0].getsockname()[1]
        return self.port

    async def start(self) -> None:
        """Bind and start accepting connections (idempotent)."""
        if self._server is None:
            ssl_context = _build_ssl_context(self.services.settings)
            # `websockets` caps a single message at 1 MiB by default — far below the media
            # limits `docs/protocol.md` promises, and a media PUT arrives as one message.
            tui = self.services.settings.tui
            max_size = max(tui.media_max_file_bytes, tui.audio_max_file_bytes) + _WS_MEDIA_HEADER_SLACK
            self._server = await websockets.serve(
                self.handle, self.host, self.port, ssl=ssl_context, max_size=max_size
            )

    async def serve(self) -> None:
        """Start (if not already) and run until `close()` stops the server."""
        await self.start()
        await self._server.wait_closed()

    async def close(self) -> None:
        """Stop accepting connections."""
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

    # -- per-connection lifecycle --------------------------------------------

    async def handle(self, ws: Any) -> None:
        """Per-connection entry point handed to `websockets.serve`.

        Refuses the connection outright if the server is already at
        `max_connections` (before authentication -- a cheap, pre-auth defense
        against exhausting server resources). Otherwise authenticates the
        mandatory first `join` frame, subscribes the member to its room on the
        hub (which emits `presence`), replays the room's recent narrative to
        THIS connection only, pushes an initial `state`, then dispatches every
        subsequent frame until the socket closes — at which point it
        unsubscribes (emitting `presence` again).
        """
        if self.max_connections > 0 and self._active_connections >= self.max_connections:
            i18n = get_i18n(self.services.settings.locale)
            await _send(ws, _error_frame("too_many_connections", i18n))
            await ws.close()
            return

        self._active_connections += 1
        try:
            member = await self._authenticate(ws)
            if member is None:
                return

            await self.hub.subscribe(member.session_key, member)
            try:
                await self._replay_history(member)
                await publish_state(self.hub, self.services, self._ctx_for(member))
                async for raw in ws:
                    if isinstance(raw, bytes | bytearray | memoryview):
                        await self._on_media_message(member, bytes(raw))
                        continue
                    await self._on_frame(member, raw)
            except ConnectionClosed:
                pass
            finally:
                self.drop_pending_media(member)
                await self.hub.unsubscribe(member)
        finally:
            self._active_connections -= 1

    async def _authenticate(self, ws: Any) -> WsMember | None:
        """Consume the mandatory first `join` frame; `welcome` + return the
        `WsMember` on success, `error` + close the socket on any failure.

        The `recv()` is bounded by `join_timeout`: an unauthenticated peer that
        opens a socket and never sends anything (or sends slowly) would
        otherwise sit open forever, since the rate limiter only applies AFTER
        auth (`dispatch_input`) — letting a hostile/broken client accumulate
        many such half-open connections and exhaust server coroutines.
        """
        i18n = get_i18n(self.services.settings.locale)
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=self.join_timeout)
        except ConnectionClosed:
            return None
        except TimeoutError:
            await _send(ws, _error_frame("join_timeout", i18n))
            await ws.close()
            return None

        frame = _parse_frame(raw)
        if frame is None or frame.get("type") != "join":
            await _send(ws, _error_frame("bad_frame", i18n))
            await ws.close()
            return None

        key = str(frame.get("key") or "")
        fields = resolve_session_fields(self.keystore, key, i18n.locale)
        if fields is None:
            await _send(ws, _error_frame("bad_key", i18n))
            await ws.close()
            return None

        member = WsMember(ws=ws, **fields)
        await _send(ws, welcome_frame(fields, imagegen=self.services.imagegen is not None))
        return member

    async def _on_media_message(self, member: WsMember, payload: bytes) -> None:
        i18n = get_i18n(member.locale)
        try:
            header, body = _unpack_media_message(payload)
            op = header.get("op")
            if op == "put":
                upload_id = str(header.get("upload_id") or "")
                await self.receive_media_put(member, upload_id, body)
                return
            if op == "get":
                sha256 = str(header.get("hash") or "")
                response_header, data = await self.get_media_bytes(member, sha256)
                await member.send_media(response_header, data)
                return
            await member.send_frame(_error_frame("bad_frame", i18n))
        except MediaError as exc:
            await member.send_frame(_error_frame(exc.code, i18n))
        except Exception:
            await member.send_frame(_error_frame("server_error", i18n))


# -- WebSocket-only helpers ------------------------------------------------


def _build_ssl_context(settings: Settings) -> ssl.SSLContext | None:
    """Build a server-side `SSLContext` from `settings.tui`'s cert/key paths, or
    `None` for plaintext (the default).

    This is the OPTIONAL native-TLS fallback (`docs/deploy.md` "TLS"): the
    recommended production setup terminates TLS at a reverse proxy in front of
    a plaintext local listener instead. Only one of the two paths being set is
    almost certainly a misconfiguration (an incomplete cert/key pair), so that
    fails fast rather than silently falling back to plaintext.
    """
    cert_path, key_path = settings.tui.tls_cert_path, settings.tui.tls_key_path
    if not cert_path and not key_path:
        return None
    if not cert_path or not key_path:
        raise ValueError(
            "TRPG_TUI__TLS_CERT_PATH and TRPG_TUI__TLS_KEY_PATH must both be set to enable native TLS (leave both blank for plaintext ws://)"  # i18n-exempt: operator/config misuse error, not user-facing chat text
        )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_path, key_path)
    return context


async def _send(ws: Any, frame: dict[str, Any]) -> None:
    """Send one JSON `frame` to `ws`, swallowing an already-closed connection."""
    try:
        await ws.send(json.dumps(frame, ensure_ascii=False))
    except ConnectionClosed:
        pass


def _pack_media_message(header: dict[str, Any], data: bytes = b"") -> bytes:
    header_bytes = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return len(header_bytes).to_bytes(_WS_MEDIA_HEADER_BYTES, "big") + header_bytes + bytes(data)


def _unpack_media_message(payload: bytes) -> tuple[dict[str, Any], bytes]:
    if len(payload) < _WS_MEDIA_HEADER_BYTES:
        raise ValueError("media_header_missing")
    header_len = int.from_bytes(payload[:_WS_MEDIA_HEADER_BYTES], "big")
    start = _WS_MEDIA_HEADER_BYTES
    end = start + header_len
    if header_len <= 0 or end > len(payload):
        raise ValueError("media_header_length_invalid")
    header = json.loads(payload[start:end])
    if not isinstance(header, dict):
        raise ValueError("media_header_not_object")
    return header, payload[end:]


async def _send_media(ws: Any, header: dict[str, Any], data: bytes = b"") -> None:
    try:
        await ws.send(_pack_media_message(header, data))
    except ConnectionClosed:
        pass
