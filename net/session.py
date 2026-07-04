"""Transport-neutral session core for the networked TUI.

The join handshake's identity resolution, the per-turn choke (`dispatch_input`), the frame
dispatch (`_on_frame`), history replay, the room `AgentCtx`, and the frame builders live here —
everything that is the SAME regardless of the wire. A transport (`net.iroh_server`) only supplies
a `Member` that can `send_frame` + `deliver`, and drives `SessionCore` per connection.

The wire protocol itself is in `docs/protocol.md`. `SessionCore` owns the shared `RoomHub`,
command router, toolset, censor and rate limiter, so every transport fans out through one bus —
a p2p player and (historically) a chat member sit at the same live table.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from collections import deque
from pathlib import Path
from typing import Any

from agent.context import AgentCtx, FsAdapter, LocalFs
from agent.kp_tools import build_kp_toolset
from agent.loop import KPTurnResult
from agent.services import Services
from agent.tools import Toolset
from gateway.commands import CommandRouter
from gateway.hub import Event, RoomHub
from gateway.ops import Censor, RateLimiter, censor_from_settings
from gateway.session import SessionSource
from gateway.turn import run_turn
from infra.i18n import I18n, get_i18n
from net.admin import handle_admin_frame, is_admin_frame
from net.keystore import Keystore

# v1.1 adds the additive, keeper-gated `admin_*` frames (see `net.admin` and `docs/protocol.md`).
_PROTOCOL_VERSION = "1.1"
_SERVER_BANNER = "loreweaver/1"

# Hard cap on a single `input` frame's text before it reaches the LLM/history. A client-controlled
# unbounded string would otherwise blow up prompt size, context cost and stored history.
_MAX_INPUT_CHARS = 4000

# How many trailing chat-history messages a join/reconnect replays to the joining connection.
_HISTORY_REPLAY_CAP = 30


def resolve_session_fields(keystore: Keystore, key: str, locale: str) -> dict[str, str] | None:
    """Resolve a raw invite `key` to a member's session fields, or `None` if unknown.

    The transport-agnostic half of the join handshake: keystore lookup (+ one hot-reload retry so
    a key minted after boot is accepted without a restart) and the derived id / AUTHORITATIVE
    display name (the keystore entry's name, never a client-supplied one — else a connection could
    impersonate another player in the room fan-out) / session scoping. Every transport builds its
    Member from this, so auth + room/role binding is identical on either wire.
    """
    entry = keystore.get(key)
    if entry is None:
        keystore.refresh()
        entry = keystore.get(key)
    if entry is None:
        return None
    client_id = f"tui:{hashlib.sha1(key.encode('utf-8')).hexdigest()[:8]}"
    name = entry.name or client_id
    source = SessionSource(
        platform="tui", chat_type="group", chat_id=entry.room, user_id=client_id, user_name=name
    )
    return {
        "id": client_id,
        "user_key": source.user_key(),
        "name": name,
        "role": entry.role,
        "room": entry.room,
        "session_key": source.chat_key(),
        "locale": locale,
    }


def welcome_frame(fields: dict[str, str]) -> dict[str, Any]:
    """Build the `welcome` frame from resolved session fields (shared by both transports)."""
    return {
        "type": "welcome",
        "protocol": _PROTOCOL_VERSION,
        "room": fields["room"],
        "you": {"id": fields["id"], "name": fields["name"], "role": fields["role"]},
        "locale": fields["locale"],
        "server": _SERVER_BANNER,
    }


def render_frame(event: Event) -> dict[str, Any] | None:
    """Render a normalized :class:`~gateway.hub.Event` into its JSON protocol frame.

    `narrative`/`dice`/`state`/`presence`/`system` map to the like-named frames; a `player_action`
    echo renders as a `narrative{speaker:"player"}`.
    """
    if event.kind == "player_action":
        return {
            "type": "narrative",
            "id": new_id(),
            "speaker": "player",
            "name": event.name,
            "text": event.text,
            "format": event.fmt,
        }
    if event.kind == "narrative":
        frame: dict[str, Any] = {
            "type": "narrative",
            "id": new_id(),
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


def parse_frame(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, (str, bytes)):
        return None
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def error_frame(code: str, i18n: I18n) -> dict[str, Any]:
    return {"type": "error", "code": code, "message": i18n.t(f"tui.error.{code}")}


def new_id() -> str:
    return uuid.uuid4().hex


class SessionCore:
    """The shared, transport-neutral engine every transport drives per connection.

    Holds the one `RoomHub` + collaborators; exposes `_replay_history`, `_on_frame`,
    `dispatch_input`, `_ctx_for`. A transport authenticates a connection (via
    `resolve_session_fields`), builds its own `Member`, subscribes it to `self.hub`, then feeds
    inbound frames to `_on_frame` — the turn flow and room fan-out are identical on any wire.
    """

    def __init__(
        self,
        services: Services,
        keystore: Keystore,
        *,
        command_router: CommandRouter | None = None,
        toolset: Toolset | None = None,
        censor: Censor | None = None,
        hub: RoomHub | None = None,
        fs: FsAdapter | None = None,
        join_timeout: float | None = None,
    ) -> None:
        self.services = services
        self.keystore = keystore
        self.fs = fs if fs is not None else LocalFs(Path.cwd())
        # An injected hub lets a transport share ONE bus with another; standalone it owns its own.
        # Built BEFORE the router + toolset so both receive it (live `.module` import progress +
        # hub-driven KP tools like companion_act publish through it).
        self.hub = hub if hub is not None else RoomHub()
        self.command_router = command_router or CommandRouter(services, hub=self.hub)
        self.toolset = toolset or build_kp_toolset(services, hub=self.hub, command_router=self.command_router)
        # From `services.settings.censor` unless injected (tests). Nothing configured = explicit no-op.
        self.censor = censor if censor is not None else censor_from_settings(services.settings.censor)
        self.rate_limiter = RateLimiter()
        # Recent AI-KP turns, for introspection (tests/admin asserting a keeper tool ran) — never wired.
        self.turns: deque[KPTurnResult] = deque(maxlen=50)
        tui_settings = services.settings.tui
        self.join_timeout = tui_settings.join_timeout if join_timeout is None else join_timeout

    async def _replay_history(self, member: Any) -> None:
        """Replay this room's recent narrative to `member` ONLY (never broadcast to the room).

        A joining/reconnecting player would otherwise see an empty log while the KP session keeps
        continuing from server-side history. Renders the last `_HISTORY_REPLAY_CAP` `chat_history`
        entries as `narrative` frames. Best-effort: any failure silently no-ops.
        """
        chat_key = self._ctx_for(member).chat_key
        try:
            raw = await self.services.store.get(user_key="", store_key=f"chat_history.{chat_key}")
            if not raw:
                return
            history = json.loads(raw)
            if not isinstance(history, list):
                return
            for entry in history[-_HISTORY_REPLAY_CAP:]:
                if not isinstance(entry, dict):
                    continue
                text = str(entry.get("content") or "").strip()
                if not text:
                    continue
                role = entry.get("role")
                speaker = "player" if role == "user" else "kp" if role == "assistant" else "system"
                fmt = "plain" if speaker == "player" else "markdown"
                await member.deliver(Event.narrative(speaker=speaker, text=text, fmt=fmt))
        except Exception:
            return

    async def _on_frame(self, member: Any, raw: Any) -> None:
        i18n = get_i18n(member.locale)
        frame = parse_frame(raw)
        if frame is None:
            await member.send_frame(error_frame("bad_frame", i18n))
            return

        kind = frame.get("type")
        if kind == "input":
            # Cap the client-controlled text before it hits the LLM/history (dispatch_input wraps
            # the turn itself in its own try/except -> error frame).
            text = str(frame.get("text") or "")[:_MAX_INPUT_CHARS]
            if text:
                await self.dispatch_input(member, text)
            return
        # Any failure in the ping/admin branches becomes a per-connection error frame, never an
        # unhandled exception that would drop the connection (mirrors dispatch_input).
        try:
            if kind == "ping":
                await member.send_frame({"type": "pong", "t": frame.get("t")})
                return
            if is_admin_frame(kind):
                # Keeper-gated admin surface. The gate is the connection's keystore role;
                # `handle_admin_frame` refuses non-keepers and scopes destructive ops to its OWN room.
                reply = await handle_admin_frame(
                    self.services, self.keystore, member.role, member.room, frame, i18n, fs=self.fs
                )
                await member.send_frame(reply)
                return
        except Exception:
            await member.send_frame(error_frame("server_error", i18n))
            return

        await member.send_frame(error_frame("bad_frame", i18n))

    async def dispatch_input(self, member: Any, text: str) -> None:
        """Drive one player turn (command or AI-KP) to completion via the hub.

        Rate-limiting and per-connection error frames stay here (transport concerns); the turn
        itself and its room fan-out are `run_turn`'s job.
        """
        i18n = get_i18n(member.locale)
        if not self.rate_limiter.allow(member.id) or not self.rate_limiter.allow(member.session_key):
            await member.send_frame(error_frame("rate_limited", i18n))
            return

        ctx = self._ctx_for(member)
        try:
            # Serialize the WHOLE turn per room (F8): two connections in the same room must not
            # interleave their read-modify-write of the shared per-room state. `run_turn` publishes
            # a companion sub-turn inline (re-entering `run_turn`, not this choke), so no re-lock.
            async with self.hub.turn_lock(member.session_key):
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
            await member.send_frame(error_frame("server_error", i18n))
            return

        if result is not None:
            self.turns.append(result)

    def _ctx_for(self, member: Any) -> AgentCtx:
        """Build the `AgentCtx` for `member`'s room, carrying the connection's keystore role in
        `extra["role"]` so `gateway.commands._privilege_level` gates keeper-only dot-commands by the
        AUTHENTICATED role — the networked TUI is a multi-user service, not a single local operator.
        """
        source = SessionSource(
            platform="tui", chat_type="group", chat_id=member.room, user_id=member.id, user_name=member.name
        )
        return AgentCtx(
            chat_key=source.chat_key(),
            user_id=member.id,
            platform="tui",
            locale=member.locale,
            fs=self.fs,
            extra={"role": member.role},
        )
