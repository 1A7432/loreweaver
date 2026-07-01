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
"""

from __future__ import annotations

import hashlib
import json
import uuid
from collections import deque
from dataclasses import dataclass
from typing import Any

import websockets
from websockets.exceptions import ConnectionClosed

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.loop import KPTurnResult
from agent.services import Services
from agent.tools import Toolset
from gateway.commands import CommandRouter
from gateway.hub import Event, RoomHub
from gateway.ops import Censor, RateLimiter
from gateway.session import SessionSource
from gateway.turn import publish_state, run_turn
from infra.i18n import I18n, get_i18n
from net.admin import handle_admin_frame, is_admin_frame
from net.keystore import Keystore

# v1.1 adds the additive, keeper-gated `admin_*` frames (see `net.admin` and
# `docs/protocol.md`); pre-admin clients are unaffected and never send them.
_PROTOCOL_VERSION = "1.1"
_SERVER_BANNER = "trpg-kp/1"


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

    async def deliver(self, event: Event) -> None:
        """Render `event` to its WS frame and send it (dropping a closed socket)."""
        frame = _render_frame(event)
        if frame is not None:
            await _send(self.ws, frame)


class TuiServer:
    """Hosts the networked TUI: one WebSocket endpoint over a shared
    `gateway.hub.RoomHub`, each room a shared AI-KP session
    (`gateway.session.SessionSource(platform="tui", ...)`)."""

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
    ) -> None:
        self.services = services
        self.keystore = keystore
        self.host = host
        self.port = port
        self.command_router = command_router or CommandRouter(services)
        self.toolset = toolset or build_kp_toolset(services)
        self.censor = censor or Censor()
        self.rate_limiter = RateLimiter()
        # An injected hub lets this WS server share ONE bus with the chat
        # gateway (app.py combined mode); standalone it owns its own (back-compat).
        self.hub = hub if hub is not None else RoomHub()
        # Recent AI-KP turns, for introspection/observability (e.g. tests and
        # admin tooling asserting a keeper-only tool actually ran) — never
        # itself broadcast over the wire.
        self.turns: deque[KPTurnResult] = deque(maxlen=50)
        self._server: Any = None

    @property
    def bound_port(self) -> int:
        """The actual listening port (resolves an ephemeral `port=0` once `start()` has run)."""
        if self._server is not None:
            return self._server.sockets[0].getsockname()[1]
        return self.port

    async def start(self) -> None:
        """Bind and start accepting connections (idempotent)."""
        if self._server is None:
            self._server = await websockets.serve(self.handle, self.host, self.port)

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

        Authenticates the mandatory first `join` frame, subscribes the member
        to its room on the hub (which emits `presence`), pushes an initial
        `state`, then dispatches every subsequent frame until the socket
        closes — at which point it unsubscribes (emitting `presence` again).
        """
        member = await self._authenticate(ws)
        if member is None:
            return

        await self.hub.subscribe(member.session_key, member)
        try:
            await publish_state(self.hub, self.services, self._ctx_for(member))
            async for raw in ws:
                await self._on_frame(member, raw)
        except ConnectionClosed:
            pass
        finally:
            await self.hub.unsubscribe(member)

    async def _authenticate(self, ws: Any) -> WsMember | None:
        """Consume the mandatory first `join` frame; `welcome` + return the
        `WsMember` on success, `error` + close the socket on any failure."""
        i18n = get_i18n(self.services.settings.locale)
        try:
            raw = await ws.recv()
        except ConnectionClosed:
            return None

        frame = _parse_frame(raw)
        if frame is None or frame.get("type") != "join":
            await _send(ws, _error_frame("bad_frame", i18n))
            await ws.close()
            return None

        key = str(frame.get("key") or "")
        entry = self.keystore.get(key)
        if entry is None:
            await _send(ws, _error_frame("bad_key", i18n))
            await ws.close()
            return None

        client_id = f"tui:{hashlib.sha1(key.encode('utf-8')).hexdigest()[:8]}"
        name = str(frame.get("name") or entry.name or client_id)
        source = SessionSource(
            platform="tui", chat_type="group", chat_id=entry.room, user_id=client_id, user_name=name
        )
        member = WsMember(
            ws=ws,
            id=client_id,
            user_key=source.user_key(),
            name=name,
            role=entry.role,
            room=entry.room,
            session_key=source.chat_key(),
            locale=i18n.locale,
        )

        await _send(
            ws,
            {
                "type": "welcome",
                "protocol": _PROTOCOL_VERSION,
                "room": member.room,
                "you": {"id": member.id, "name": member.name, "role": member.role},
                "locale": member.locale,
                "server": _SERVER_BANNER,
            },
        )
        return member

    async def _on_frame(self, member: WsMember, raw: Any) -> None:
        i18n = get_i18n(member.locale)
        frame = _parse_frame(raw)
        if frame is None:
            await _send(member.ws, _error_frame("bad_frame", i18n))
            return

        kind = frame.get("type")
        if kind == "input":
            text = str(frame.get("text") or "")
            if text:
                await self.dispatch_input(member, text)
            return
        if kind == "ping":
            await _send(member.ws, {"type": "pong", "t": frame.get("t")})
            return
        if is_admin_frame(kind):
            # Keeper-gated admin surface (LLM config + room keys). The gate is the
            # connection's keystore role; `handle_admin_frame` refuses non-keepers.
            reply = await handle_admin_frame(self.services, self.keystore, member.role, frame, i18n)
            await _send(member.ws, reply)
            return

        await _send(member.ws, _error_frame("bad_frame", i18n))

    # -- turn flow (M4 §1 "Turn flow", now via the hub) -----------------------

    async def dispatch_input(self, member: WsMember, text: str) -> None:
        """Drive one player turn (command or AI-KP) to completion via the hub.

        Rate-limiting and per-connection error frames stay here (transport
        concerns); the turn itself and its room fan-out are `run_turn`'s job.
        """
        i18n = get_i18n(member.locale)
        if not self.rate_limiter.allow(member.id) or not self.rate_limiter.allow(member.session_key):
            await _send(member.ws, _error_frame("rate_limited", i18n))
            return

        ctx = self._ctx_for(member)
        try:
            result = await run_turn(
                self.hub,
                self.services,
                ctx,
                text,
                command_router=self.command_router,
                toolset=self.toolset,
                censor=self.censor,
                origin=member,
            )
        except Exception:
            await _send(member.ws, _error_frame("server_error", i18n))
            return

        if result is not None:
            self.turns.append(result)

    # -- helpers ------------------------------------------------------------

    def _ctx_for(self, member: WsMember) -> AgentCtx:
        """Build the `AgentCtx` for `member`'s room (M4 §"Auth / keystore")."""
        source = SessionSource(
            platform="tui", chat_type="group", chat_id=member.room, user_id=member.id, user_name=member.name
        )
        return AgentCtx(chat_key=source.chat_key(), user_id=member.id, platform="tui", locale=member.locale)


# -- module-level framing helpers ------------------------------------------


def _render_frame(event: Event) -> dict[str, Any] | None:
    """Render a normalized :class:`~gateway.hub.Event` into its WS JSON frame.

    This is the terminal transport's renderer: `narrative`/`dice`/`state`/
    `presence`/`system` map to the like-named frames, and a `player_action`
    echo renders as a `narrative{speaker:"player"}` (the input echo).
    """
    if event.kind == "player_action":
        return {
            "type": "narrative",
            "id": _new_id(),
            "speaker": "player",
            "name": event.name,
            "text": event.text,
            "format": event.fmt,
        }
    if event.kind == "narrative":
        frame: dict[str, Any] = {
            "type": "narrative",
            "id": _new_id(),
            "speaker": event.speaker,
            "text": event.text,
            "format": event.fmt,
        }
        if event.name:
            frame["name"] = event.name
        return frame
    if event.kind == "dice":
        return {"type": "dice", **event.data}
    if event.kind == "state":
        return dict(event.data)
    if event.kind == "presence":
        return {"type": "presence", **event.data}
    if event.kind == "system":
        return {"type": "system", "level": event.data.get("level", ""), "text": event.text}
    return None


async def _send(ws: Any, frame: dict[str, Any]) -> None:
    """Send one JSON `frame` to `ws`, swallowing an already-closed connection."""
    try:
        await ws.send(json.dumps(frame, ensure_ascii=False))
    except ConnectionClosed:
        pass


def _parse_frame(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, (str, bytes)):
        return None
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _error_frame(code: str, i18n: I18n) -> dict[str, Any]:
    return {"type": "error", "code": code, "message": i18n.t(f"tui.error.{code}")}


def _new_id() -> str:
    return uuid.uuid4().hex
