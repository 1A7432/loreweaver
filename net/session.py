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

import asyncio
import json
import logging
import uuid
from collections import deque
from pathlib import Path
from typing import Any

from agent.context import AgentCtx, FsAdapter, LocalFs
from agent.history import DEFAULT_HISTORY_KEY, load_chain
from agent.kp_tools import build_kp_toolset
from agent.loop import KPTurnResult
from agent.services import Services
from agent.tools import Toolset
from gateway.audio import add_audio_item, audio_state_frame, has_audio_state, list_audio_items
from gateway.avatar import AvatarError, set_user_avatar
from gateway.commands import CommandRouter
from gateway.demo import is_demo_setup_request, is_guided_demo_request
from gateway.hub import TURN_QUEUED_KEY, Event, RoomHub
from gateway.media import MEDIA_HISTORY_REPLAY_CAP, media_frame, record_media_history
from gateway.ops import Censor, RateLimiter, censor_from_settings, is_media_enabled, set_media_enabled
from gateway.session import SessionSource
from gateway.turn import TURN_EVENT_HISTORY_KEY, publish_state, run_turn
from infra.i18n import I18n, get_i18n
from infra.media_store import (
    ALLOWED_AUDIO_MIMES,
    ALLOWED_IMAGE_MIMES,
    ALLOWED_MEDIA_MIMES,
    MediaError,
    MediaRecord,
    MediaStore,
    PendingUpload,
    is_audio_mime,
    is_image_mime,
)
from infra.version import resolve_version
from net.admin import AdminService, is_admin_frame
from net.keystore import Keystore, member_id_for_key
from net.room_backup import room_rows, room_vector_points

logger = logging.getLogger(__name__)

# v2.3 adds `kind` to every `pack_cards` entry — the 拆卡 classification a picker needs
# to send the right import verb (without it every client hard-coded `.import <ref> pc`
# and a world card was offered to players as a character). v2.2 added the installed-pack
# card listing (`list_pack_cards` → `pack_cards`), the structured lane behind
# "import from installed pack" pickers. v1.8 added module UI
# panels (M15): per-viewer `ui_manifest`, hook-emitted `panel_event`, the
# `panel_intent` client frame, and pack-asset resolution on the media byte channel.
# v1.7 added declarative hook-emitted `ui` frames (core.hooks emitUI); v1.6 added
# player-visible module variables on the state frame.
_PROTOCOL_VERSION = "2.3"
# Public alias for out-of-band consumers (the `.lwpack` engine-minimum check in app.py).
PROTOCOL_VERSION = _PROTOCOL_VERSION
_SERVER_BANNER = "loreweaver/1"

# Hard cap on a single `input` frame's text before it reaches the LLM/history. A client-controlled
# unbounded string would otherwise blow up prompt size, context cost and stored history.
_MAX_INPUT_CHARS = 4000

# Hard cap on a `panel_intent` frame's value (protocol v1.8) — tighter than the input
# cap because an intent is a single choice/expression, never free prose.
_MAX_PANEL_INTENT_CHARS = 2000
_PANEL_INTENT_KINDS = frozenset({"choice", "input", "roll"})

# How many trailing chat-history messages a join/reconnect replays to the joining connection.
_HISTORY_REPLAY_CAP = 30
# Live events a member may hold while its own join replay runs (see `_replay_history`).
_HELD_EVENTS_CAP = 1000


def resolve_session_fields(keystore: Keystore, key: str, locale: str) -> dict[str, str] | None:
    """Resolve a raw invite `key` to a member's session fields, or `None` if unknown.

    The transport-agnostic half of the join handshake: keystore lookup (+ one hot-reload retry so
    a key minted after boot is accepted without a restart) and the derived id / AUTHORITATIVE
    display name (the keystore entry's name, never a client-supplied one — else a connection could
    impersonate another player in the room fan-out) / session scoping. Every transport builds its
    Member from this, so auth + room/role binding is identical on either wire.
    """
    try:
        # Always refresh a file-backed store, even when memory already contains
        # this key: a deleted/downgraded key must not authenticate from stale RAM.
        keystore.refresh()
    except Exception:
        return None
    entry = keystore.get(key)
    if entry is None:
        return None
    client_id = member_id_for_key(key)
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


def welcome_frame(
    fields: dict[str, str], *, imagegen: bool = False, demo: bool = False, can_update: bool = False
) -> dict[str, Any]:
    """Build the `welcome` frame from resolved session fields (shared by both transports)."""
    features = ["media", "audio"]
    if imagegen:
        features.append("imagegen")
    if demo:
        # Additive capability flag: clients that know it can offer a guided
        # first-run adventure; older clients simply ignore the extra string.
        features.append("demo")
    if can_update:
        # The operator configured a self-update command AND this connection is a keeper,
        # so the client may offer a "update the server" control (see `admin_update_server`).
        features.append("update")
    return {
        "type": "welcome",
        "protocol": _PROTOCOL_VERSION,
        "features": features,
        "room": fields["room"],
        "you": {"id": fields["id"], "name": fields["name"], "role": fields["role"]},
        "locale": fields["locale"],
        "server": _SERVER_BANNER,
        "version": resolve_version(),
    }


def uses_demo_llm(services: Services) -> bool:
    """Whether turns currently route to the offline fallback Keeper.

    ``MutableLLM.using_fallback`` changes immediately after a model hot-swap,
    so a reconnect receives an accurate capability flag without coupling the
    session layer to the concrete demo responder.
    """
    return bool(getattr(services.llm, "using_fallback", False))


def is_guided_demo_action(text: str) -> bool:
    """Whether ``text`` is the localized action emitted by the first-run button."""
    return is_guided_demo_request(text)


async def guided_demo_available(services: Services, chat_key: str) -> bool:
    """Offer the destructive sample setup only to a genuinely empty room.

    The check includes the room's documents, its room_state rows, binding KV
    rows, vector documents, and indexed media. Any inspection failure fails
    closed. The room turn lock rechecks this immediately before the guided
    turn, so a stale welcome frame cannot overwrite a live campaign.
    """
    if not uses_demo_llm(services) or not services.settings.enable_vector_db:
        return False
    try:
        if (
            await services.store.doc_list(chat_key)
            or await services.store.state_list(chat_key)
            or await room_rows(services, chat_key)
            or await room_vector_points(services, chat_key)
        ):
            return False
        tui = services.settings.tui
        media = MediaStore(
            services.store,
            services.settings.data_dir,
            max_file_bytes=max(tui.media_max_file_bytes, tui.audio_max_file_bytes),
            room_quota_bytes=max(tui.media_room_quota_bytes, tui.audio_room_quota_bytes),
            allowed_mimes=ALLOWED_MEDIA_MIMES,
        )
        return not await media.list_room_records(chat_key)
    except Exception:
        logger.warning("demo: could not verify empty room %s; hiding guided setup", chat_key, exc_info=True)
        return False


def render_frame(event: Event) -> dict[str, Any] | None:
    """Render a normalized :class:`~gateway.hub.Event` into its JSON protocol frame.

    `narrative`/`dice`/`ui`/`state`/`presence`/`system`/`turn_status` map to the like-named
    frames; a `player_action` echo renders as a `narrative{speaker:"player"}`.
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
            "id": event.data.get("frame_id") or new_id(),
            "speaker": event.speaker,
            "text": event.text,
            "format": event.fmt,
        }
        if event.name:
            frame["name"] = event.name
        return frame
    if event.kind == "narrative_delta":
        delta: dict[str, Any] = {
            "type": "narrative_delta",
            "id": event.data.get("frame_id") or new_id(),
            "speaker": event.speaker,
            "text": event.text,
        }
        if event.name:
            delta["name"] = event.name
        return delta
    if event.kind == "dice":
        return {"type": "dice", **event.data}
    if event.kind == "ui":
        return {"type": "ui", **event.data}
    if event.kind == "state":
        return dict(event.data)
    if event.kind == "panel":
        return dict(event.data)
    if event.kind in ("ui_manifest", "panel_event"):
        # v1.8 module-panel frames: the event data IS the wire frame (type included),
        # already validated + per-viewer filtered by `gateway.panels`.
        return dict(event.data)
    if event.kind == "presence":
        return {"type": "presence", **event.data}
    if event.kind == "system":
        frame = {"type": "system", "level": event.data.get("level", ""), "text": event.text}
        if event.data.get("spinner"):
            frame["spinner"] = True
        return frame
    if event.kind == "turn_status":
        return {"type": "turn_status", **event.data}
    if event.kind == "media":
        return dict(event.data)
    if event.kind == "audio":
        return dict(event.data)
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


# Fire-and-forget sends need a strong reference or the loop may collect them mid-flight.
_QUEUE_NOTICES: set[asyncio.Task[Any]] = set()


def notify_turn_queued(member: Any, i18n: I18n) -> None:
    """Privately tell one connection its input is waiting behind the room's running turn.

    Deliberately NOT awaited: the notice must not sit between the `locked()` check and
    `acquire()`, because the lock's waiter queue is what makes queued input run in arrival
    order — an await there would let two racing inputs swap places. A failed send is a
    cosmetic loss, so it is swallowed rather than failing the turn that follows.
    """

    async def _send() -> None:
        try:
            await member.send_frame({"type": "system", "level": "info", "text": i18n.t(TURN_QUEUED_KEY)})
        except Exception:
            logger.debug("Could not deliver the turn-queued notice", exc_info=True)

    task = asyncio.create_task(_send())
    _QUEUE_NOTICES.add(task)
    task.add_done_callback(_QUEUE_NOTICES.discard)


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
        # data_dir rides along as an extra allowed base so installed-pack refs
        # (`.import <packId>/...`) resolve even when data_dir is outside cwd.
        self.fs = fs if fs is not None else LocalFs(Path.cwd(), extra_bases=(Path(services.settings.data_dir),))
        # An injected hub lets a transport share ONE bus with another; standalone it owns its own.
        # Built BEFORE the router + toolset so both receive it (live `.module` import progress +
        # hub-driven KP tools like companion_act publish through it).
        self.hub = hub if hub is not None else RoomHub()
        self.admin = AdminService(services, keystore, fs=self.fs, hub=self.hub)
        self.command_router = command_router or CommandRouter(
            services,
            keystore=keystore,
            hub=self.hub,
        )
        self.toolset = toolset or build_kp_toolset(services, hub=self.hub, command_router=self.command_router)
        # From `services.settings.censor` unless injected (tests). Nothing configured = explicit no-op.
        self.censor = censor if censor is not None else censor_from_settings(services.settings.censor)
        self.rate_limiter = RateLimiter()
        tui_settings = services.settings.tui
        uploads_per_minute = max(1, int(tui_settings.media_uploads_per_minute))
        self.media_upload_limiter = RateLimiter(uploads_per_minute, uploads_per_minute / 60.0)
        self.media_store = MediaStore(
            services.store,
            services.settings.data_dir,
            max_file_bytes=max(tui_settings.media_max_file_bytes, tui_settings.audio_max_file_bytes),
            room_quota_bytes=max(tui_settings.media_room_quota_bytes, tui_settings.audio_room_quota_bytes),
            allowed_mimes=ALLOWED_MEDIA_MIMES,
        )
        self._pending_media: dict[str, PendingUpload] = {}
        # Recent AI-KP turns, for introspection (tests/admin asserting a keeper tool ran) — never wired.
        self.turns: deque[KPTurnResult] = deque(maxlen=50)
        self.join_timeout = tui_settings.join_timeout if join_timeout is None else join_timeout

    async def _recorded_turn_events(self, chat_key: str) -> dict[str, list[tuple[str, Event]]]:
        """`after_id -> [(record id, event)]`, rebuilt from `gateway.turn`'s replay lane.

        `after_id` is the history message each event followed live (`""` = before the
        first message). Best-effort like the rest of replay, per RECORD: one malformed
        entry costs that roll, not the lane — and never the transcript around it (a
        record that raised here used to escape into `_replay_history`'s blanket except
        and abort the whole join replay silently).
        """
        events: dict[str, list[tuple[str, Event]]] = {}
        try:
            raw = await self.services.store.state_get(chat_key, TURN_EVENT_HISTORY_KEY)
            records = json.loads(raw) if raw else []
        except Exception:
            logger.debug("replay: turn event history unreadable for %s", chat_key, exc_info=True)
            return events
        if not isinstance(records, list):
            return events
        for record in records:
            try:
                if not isinstance(record, dict) or not isinstance(record.get("event"), dict):
                    continue
                payload = record["event"]
                events.setdefault(str(record.get("after_id") or ""), []).append(
                    (
                        str(record.get("id") or ""),
                        Event(
                            kind=str(payload.get("kind") or ""),
                            speaker=str(payload.get("speaker") or ""),
                            name=str(payload.get("name") or ""),
                            text=str(payload.get("text") or ""),
                            fmt=str(payload.get("fmt") or "plain"),
                            data=payload.get("data") if isinstance(payload.get("data"), dict) else {},
                        ),
                    )
                )
            except Exception:
                logger.debug("replay: skipping a malformed turn event record for %s", chat_key, exc_info=True)
        return events

    async def _replay_history(self, member: Any) -> None:
        """Replay this room's recent narrative to `member` ONLY (never broadcast to the room).

        A joining/reconnecting player would otherwise see an empty log while the KP session keeps
        continuing from server-side history. Renders the last `_HISTORY_REPLAY_CAP` `chat_history`
        entries as `narrative` frames, each KP reply preceded by that turn's public tool events —
        the dice and the NPC lines. Those used to be dropped, because only prose was ever stored:
        a member who reconnected got a transcript with every roll missing while everyone who
        stayed connected kept theirs, so the same scene read differently at one table.
        Best-effort: any failure silently no-ops.
        """
        chat_key = self._ctx_for(member).chat_key
        # Both carriers subscribe the member to the hub BEFORE replaying (subscribing
        # after would lose every frame published in between). So an in-flight turn's
        # live frames — since 2.3 including its dice and NPC lines as they happen —
        # could land between two REPLAYED lines. The member holds live events for the
        # duration and they are flushed, in order, right after the replay: the joiner
        # reads the past first, then the present, and misses nothing.
        hold: list[Event] = []
        replayed: set[str] = set()
        member.held_events = hold
        try:
            await self._replay_history_body(member, chat_key, replayed)
        finally:
            member.held_events = None
            try:
                await self._flush_held(member, chat_key, hold, replayed)
            except Exception:
                logger.debug("replay: flushing held live events failed for %s", chat_key, exc_info=True)

    async def _flush_held(self, member: Any, chat_key: str, hold: list[Event], replayed: set[str]) -> None:
        """Deliver the live events held during `member`'s replay — once each.

        A roll typed, or a turn settled, WHILE the replay ran was published live (held
        here) AND written where the replay reads (the lane, the history); whatever the
        reads caught was replayed above too. Every such live event carries the id of its
        persisted record (`Event.origin_id`, stamped by `gateway.turn`), and the replay
        recorded the ids it emitted: a held event whose record was replayed is dropped —
        by IDENTITY, so a second, identical roll is still delivered — and so are the held
        `narrative_delta`s of a dropped final (a draft the client would otherwise open
        and never see closed).
        """
        # Bounded like every other replay lane: a joiner whose socket stalls mid-replay
        # must not accumulate an in-flight streaming turn without limit. Dropping the
        # OLDEST keeps the newest state; a dropped delta is superseded by its final frame
        # anyway, and every dice/NPC frame is also in the lane.
        if len(hold) > _HELD_EVENTS_CAP:
            logger.debug("replay: dropping %d held live events for %s", len(hold) - _HELD_EVENTS_CAP, chat_key)
            del hold[: len(hold) - _HELD_EVENTS_CAP]
        dropped_frames = {
            str((event.data or {}).get("frame_id") or "")
            for event in hold
            if event.kind == "narrative" and event.origin_id and event.origin_id in replayed
        }
        dropped_frames.discard("")
        for event in hold:
            if event.origin_id and event.origin_id in replayed:
                continue
            if event.kind == "narrative_delta" and str((event.data or {}).get("frame_id") or "") in dropped_frames:
                continue
            try:
                await member.deliver(event)
            except Exception:
                break  # the connection is gone or was revoked; the loop's owner handles it

    async def _deliver_replay(self, member: Any, event: Event, replayed: set[str], origin_id: str = "") -> None:
        """Send one REPLAYED event now — past the hold that queues live ones, but through
        the same per-event authorization check `deliver` applies (a key revoked mid-join
        gets nothing further, exactly as it would from a live publish). `origin_id` is the
        persisted record this event was rebuilt from; it joins `replayed` once the frame
        has actually gone out (see `_flush_held`)."""
        authorize = getattr(member, "authorize", None)
        if authorize is not None and not authorize():
            raise PermissionError("member authorization was revoked")  # i18n-exempt: internal hub signal
        frame = render_frame(event)
        if frame is not None:
            await member.send_frame(frame)
            if origin_id:
                replayed.add(origin_id)

    async def _replay_history_body(self, member: Any, chat_key: str, replayed: set[str]) -> None:
        try:
            # M20 D moved the conversation into the append-only history tree; the
            # `room_state` blob of the same name survives only in rooms that upgraded
            # and have not taken a turn yet (the first turn adopts and clears it). So
            # the tree is the source and the blob the fallback — reading only the blob
            # replayed NOTHING for every post-migration room.
            history: list = await load_chain(self.services, chat_key, DEFAULT_HISTORY_KEY)
            if not history:
                raw = await self.services.store.state_get(chat_key, "chat_history")
                legacy = json.loads(raw) if raw else []
                history = legacy if isinstance(legacy, list) else []
            events_by_anchor = await self._recorded_turn_events(chat_key)
            entries = [entry for entry in history if isinstance(entry, dict)]
            window = entries[-_HISTORY_REPLAY_CAP:]
            before_window = entries[:-_HISTORY_REPLAY_CAP] if len(entries) > _HISTORY_REPLAY_CAP else []

            async def _deliver_anchored(anchor: str) -> None:
                for record_id, event in events_by_anchor.pop(anchor, []):
                    await self._deliver_replay(member, event, replayed, record_id)

            # A pre-M20 room_state blob (adopted into the tree by the first AI turn) has
            # no message ids: nothing anchors to its lines, and every roll typed in such
            # a room so far is root-anchored — those happened AFTER the blob's transcript,
            # so they replay after it, not at the top.
            legacy_blob = bool(entries) and not any(entry.get("_lw_id") for entry in entries)
            # Rolls and lines that happened right before the window's first message: after
            # the last message OUTSIDE it, or — when the window is the whole transcript —
            # before any message at all (typed rolls in a room whose first AI turn has
            # not come yet). Anything earlier falls outside the window exactly as its
            # narration does.
            if before_window:
                await _deliver_anchored(str(before_window[-1].get("_lw_id") or ""))
            elif not legacy_blob:
                await _deliver_anchored("")
            for entry in window:
                text = str(entry.get("content") or "").strip()
                role = entry.get("role")
                # Replay is STORY continuity, not an ops log: dot-command echoes and
                # their system responses (setup acks, ".panels enable" …) read as
                # backstage noise to a joining player, so only the narrative lanes
                # (player utterances + KP prose) replay. An EMPTY reply (a final round
                # that was all stripped machinery) renders nothing; the rolls anchored
                # to the messages around it still do — the roll happened, the prose did
                # not.
                anchor = str(entry.get("_lw_id") or "")
                if text and role == "user" and not text.startswith((".", "/")):
                    await self._deliver_replay(
                        member, Event.narrative(speaker="player", text=text, fmt="plain"), replayed, anchor
                    )
                elif text and role == "assistant":
                    await self._deliver_replay(
                        member, Event.narrative(speaker="kp", text=text, fmt="markdown"), replayed, anchor
                    )
                # …then everything that happened right after this message, live: the
                # KP's rolls after the player's line, a companion's exchange, a typed roll
                # after the reply. The legacy room_state blob has no ids: nothing anchors.
                if anchor:
                    await _deliver_anchored(anchor)
            if legacy_blob:
                await _deliver_anchored("")
            media_raw = await self.services.store.state_get(chat_key, "media_history")
            media_history = json.loads(media_raw) if media_raw else []
            if isinstance(media_history, list):
                for frame in media_history[-MEDIA_HISTORY_REPLAY_CAP:]:
                    if isinstance(frame, dict) and frame.get("type") == "media":
                        await self._deliver_replay(member, Event.media(frame), replayed)
            audio_items = await list_audio_items(self.services.store, chat_key)
            for frame in audio_items[-MEDIA_HISTORY_REPLAY_CAP:]:
                await self._deliver_replay(member, Event.audio(frame), replayed)
            if audio_items or await has_audio_state(self.services.store, chat_key):
                await self._deliver_replay(member, Event.audio(await audio_state_frame(self.services.store, chat_key)), replayed)
            # The room's upload policy greets a joining member (UPSTREAM item 14, from
            # the studio): the toggle reply used to be unicast to the issuing keeper, so
            # everyone else could only learn "uploads are off" from their first refused
            # offer. Only the NON-default state is announced — enabled is the default
            # assumption, and an unconditional extra frame would reshape every join
            # sequence for nothing.
            if not await is_media_enabled(self.services.store, chat_key):
                await self._deliver_replay(member, Event.media({"type": "media_enabled", "enabled": False}), replayed)
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
            # Reject an oversized client-controlled message explicitly: silently slicing it can
            # make the Keeper answer a different action than the player submitted. Keep the final
            # slice as a defense in depth so this choke remains bounded if normalization changes.
            raw_text = str(frame.get("text") or "")
            if len(raw_text) > _MAX_INPUT_CHARS:
                await member.send_frame(error_frame("input_too_long", i18n))
                return
            text = raw_text[:_MAX_INPUT_CHARS]
            if text:
                await self.dispatch_input(member, text)
            return
        # Any failure in the ping/admin branches becomes a per-connection error frame, never an
        # unhandled exception that would drop the connection (mirrors dispatch_input).
        try:
            if kind == "ping":
                await member.send_frame({"type": "pong", "t": frame.get("t")})
                return
            if not self._refresh_member_authorization(member):
                await member.send_frame(error_frame("forbidden", i18n))
                return
            if kind == "panel_intent":
                await self._handle_panel_intent(member, frame)
                return
            if kind == "list_pack_cards":
                # v2.2, player-open: card FILENAMES from installed packs — claimable
                # knowledge (the install banner prints them), never card content. The
                # same inventory `.import list` prints, in structured form for pickers.
                # v2.3 adds each entry's `kind` so a picker sends the right verb. It
                # walks the pack dirs on the event loop, so it spends the same
                # per-member / per-room allowance an input does — a client looping the
                # frame is throttled exactly like one looping `.import list`.
                from gateway.panels import installed_card_entries

                if not self.rate_limiter.allow(member.id) or not self.rate_limiter.allow(member.session_key):
                    await member.send_frame(error_frame("rate_limited", i18n))
                    return
                await member.send_frame(
                    {
                        "type": "pack_cards",
                        "cards": installed_card_entries(Path(self.services.settings.data_dir)),
                    }
                )
                return
            if kind == "media_offer":
                async with self.hub.turn_lock(member.session_key):
                    if not self._refresh_member_authorization(member):
                        await member.send_frame(error_frame("forbidden", i18n))
                        return
                    await self._handle_media_offer(member, frame)
                return
            if kind == "media_set_enabled":
                async with self.hub.turn_lock(member.session_key):
                    if not self._refresh_member_authorization(member):
                        await member.send_frame(error_frame("forbidden", i18n))
                        return
                    await self._handle_media_set_enabled(member, frame)
                return
            if kind == "avatar_set":
                async with self.hub.turn_lock(member.session_key):
                    if not self._refresh_member_authorization(member):
                        await member.send_frame(error_frame("forbidden", i18n))
                        return
                    await self._handle_avatar_set(member, frame)
                return
            if is_admin_frame(kind):
                if kind in {
                    "admin_delete_room",
                    "admin_export_room",
                    "admin_import_room",
                    "admin_delete_room_data",
                    # A reset mutates the same documents/room_state a mid-flight turn's
                    # tool calls are writing — it belongs behind the room lock with the
                    # other destructive ops (it was the one omission from this set).
                    "admin_reset_room",
                    "admin_generate",
                }:
                    async with self.hub.turn_lock(member.session_key):
                        if not self._refresh_member_authorization(member):
                            await member.send_frame(error_frame("forbidden", i18n))
                            return
                        if kind in {"admin_import_room", "admin_delete_room_data"}:
                            self._drop_pending_room(member.session_key)
                        reply = await self.admin.dispatch(
                            member.role,
                            member.room,
                            frame,
                            i18n,
                            reauthorize=lambda: self._refresh_member_authorization(member),
                        )
                else:
                    if not self._refresh_member_authorization(member):
                        await member.send_frame(error_frame("forbidden", i18n))
                        return
                    reply = await self.admin.dispatch(
                        member.role,
                        member.room,
                        frame,
                        i18n,
                        reauthorize=lambda: self._refresh_member_authorization(member),
                    )
                await member.send_frame(reply)
                if kind in {"admin_delete_room", "admin_delete_room_data"} and reply.get(
                    "type"
                ) not in {"error", "admin_error"}:
                    # The dispatch above retired the room while HOLDING its turn lock, so
                    # `delete_room_data`'s in-op disposal necessarily declined (a held lock
                    # must never be swapped out from under its holder). The `async with`
                    # released it just above and the retired room cannot mint another —
                    # this is the one place that knows both facts, so it drops the
                    # bookkeeping (M23 review: the in-op path alone was dead code here).
                    self.hub.dispose_room(member.session_key)
                if kind == "admin_set_model" and reply.get("type") == "admin_config":
                    await self._broadcast_admin_config(reply, exclude=member)
                return
        except Exception:
            await member.send_frame(error_frame("server_error", i18n))
            return

        await member.send_frame(error_frame("bad_frame", i18n))

    def _refresh_member_authorization(self, member: Any) -> bool:
        """Refresh a live connection's current room/role binding, failing closed."""
        try:
            entry = self.keystore.authorize_member(member.id, room=member.room)
        except Exception:
            logger.warning(
                "auth: could not refresh member %s",
                getattr(member, "id", "unknown"),
                exc_info=True,
            )
            return False
        if entry is None:
            return False
        member.role = entry.role
        if entry.name:
            member.name = entry.name
        return True

    async def _broadcast_admin_config(self, frame: dict[str, Any], *, exclude: Any) -> None:
        """Best-effort refresh every connected Keeper after a deployment-wide model switch."""
        seen: set[int] = set()
        for members in list(self.hub.rooms.values()):
            for peer in list(members):
                marker = id(peer)
                if peer is exclude or marker in seen:
                    continue
                seen.add(marker)
                send_frame = getattr(peer, "send_frame", None)
                if send_frame is None:
                    continue
                # A long-lived connection's cached role can be stale after an operations-side
                # downgrade/revocation. Re-authorize before sending deployment details such as
                # provider/base URL and saved-provider names.
                if not self._refresh_member_authorization(peer) or getattr(peer, "role", "") != "keeper":
                    continue
                try:
                    await send_frame(frame)
                except Exception:
                    logger.warning(
                        "admin: could not refresh config for member %s",
                        getattr(peer, "id", "unknown"),
                        exc_info=True,
                    )

    async def _handle_media_offer(self, member: Any, frame: dict[str, Any]) -> None:
        i18n = get_i18n(member.locale)
        if not await is_media_enabled(self.services.store, member.session_key):
            await member.send_frame(error_frame("media_disabled", i18n))
            return
        if not self.media_upload_limiter.allow(f"media:{member.session_key}:{member.id}"):
            await member.send_frame(error_frame("media_rate_limited", i18n))
            return

        name = str(frame.get("name") or "media").strip()[:255] or "media"
        mime = str(frame.get("mime") or "").lower()
        sha256 = str(frame.get("sha256") or "").lower()
        policy = self._media_policy(mime)
        try:
            size = int(frame.get("size") or 0)
            existing = await self.media_store.validate_offer(
                room=member.session_key,
                mime=mime,
                size=size,
                sha256=sha256,
                max_file_bytes=policy["max_file_bytes"],
                room_quota_bytes=policy["room_quota_bytes"],
                allowed_mimes=policy["allowed_mimes"],
            )
        except (TypeError, ValueError, MediaError) as exc:
            code = exc.code if isinstance(exc, MediaError) else "media_bad_offer"
            await member.send_frame(error_frame(code, i18n))
            return

        if existing is not None:
            if is_audio_mime(existing.mime):
                audio_frame = await self._publish_audio_item(member, existing)
                await member.send_frame({"type": "media_accept", "upload_id": "", "existing": True, "audio": audio_frame})
            else:
                media_frame = self._media_frame(existing, member)
                await member.send_frame({"type": "media_accept", "upload_id": "", "existing": True, "media": media_frame})
                await self._publish_media(member, media_frame)
            return

        upload_id = new_id()
        self._pending_media[upload_id] = PendingUpload(
            upload_id=upload_id,
            room=member.session_key,
            mime=mime,
            size=size,
            name=name,
            uploader=member.id,
            sha256=sha256,
            max_file_bytes=policy["max_file_bytes"],
            room_quota_bytes=policy["room_quota_bytes"],
            allowed_mimes=policy["allowed_mimes"],
        )
        await member.send_frame({"type": "media_accept", "upload_id": upload_id})

    def _media_policy(self, mime: str) -> dict[str, Any]:
        tui = self.services.settings.tui
        if is_image_mime(mime):
            return {
                "max_file_bytes": tui.media_max_file_bytes,
                "room_quota_bytes": tui.media_room_quota_bytes,
                "allowed_mimes": ALLOWED_IMAGE_MIMES,
            }
        if is_audio_mime(mime):
            return {
                "max_file_bytes": tui.audio_max_file_bytes,
                "room_quota_bytes": tui.audio_room_quota_bytes,
                "allowed_mimes": ALLOWED_AUDIO_MIMES,
            }
        return {
            "max_file_bytes": max(tui.media_max_file_bytes, tui.audio_max_file_bytes),
            "room_quota_bytes": max(tui.media_room_quota_bytes, tui.audio_room_quota_bytes),
            "allowed_mimes": ALLOWED_MEDIA_MIMES,
        }

    async def _handle_panel_intent(self, member: Any, frame: dict[str, Any]) -> None:
        """Route one `panel_intent` frame (protocol v1.8) exactly as if the member typed it.

        The privilege model is "a panel acts as the player viewing it": after checking
        the named panel is in THIS member's own manifest (audience-filtered by role —
        an intent against a panel outside it is refused, so a player can never actuate
        a keeper-only panel), the value re-enters the NORMAL input choke
        (`dispatch_input`: rate limits, turn lock, re-auth, command privilege gates all
        apply). `choice`/`input` submit the value verbatim; `roll` runs a public
        `.r <value>` as that player, so the real dice engine validates the expression.
        """
        i18n = get_i18n(member.locale)
        panel = str(frame.get("panel") or "")
        intent_kind = frame.get("kind")
        raw_value = frame.get("value")
        if not panel or intent_kind not in _PANEL_INTENT_KINDS or not isinstance(raw_value, str):
            await member.send_frame(error_frame("bad_frame", i18n))
            return
        if len(raw_value) > _MAX_PANEL_INTENT_CHARS:
            await member.send_frame(error_frame("input_too_long", i18n))
            return
        value = raw_value.strip()
        if not value:
            await member.send_frame(error_frame("bad_frame", i18n))
            return
        from gateway.panels import member_panel_ids

        allowed = await member_panel_ids(self.services, member.session_key, str(member.role or ""))
        if panel not in allowed:
            await member.send_frame(error_frame("forbidden", i18n))
            return
        if intent_kind == "roll":
            # Collapse all whitespace: a roll value is one dice expression for the
            # command line being synthesized, never multi-line text.
            value = ".r " + " ".join(value.split())
        await self.dispatch_input(member, value)

    async def send_ui_manifest(self, member: Any) -> None:
        """Send this member its own audience-filtered panel manifest (protocol v1.8).

        Called by the transports right after the join-time `state` frame, and cheap to
        call unconditionally: a room with no enabled panel packs yields the empty
        full-replace manifest, which also clears stale panels on reconnect. Best-effort
        — a failure here never breaks the join.
        """
        try:
            from gateway.panels import build_ui_manifest_frame

            frame = await build_ui_manifest_frame(self.services, member.session_key, str(member.role or ""))
            await member.send_frame(frame)
        except Exception:
            logger.warning("panels: could not send ui_manifest to %s", getattr(member, "id", member), exc_info=True)

    async def _handle_media_set_enabled(self, member: Any, frame: dict[str, Any]) -> None:
        i18n = get_i18n(member.locale)
        if member.role != "keeper":
            await member.send_frame(error_frame("forbidden", i18n))
            return
        enabled = bool(frame.get("enabled"))
        await set_media_enabled(self.services.store, member.session_key, enabled)
        # Broadcast, not a unicast ack (UPSTREAM item 14): every member's client may
        # gate its upload surface on the policy, not only the keeper who flipped it.
        # The issuer is a room member too, so the old ack arrives as part of this.
        await self.hub.publish(member.session_key, Event.media({"type": "media_enabled", "enabled": enabled}))

    async def _handle_avatar_set(self, member: Any, frame: dict[str, Any]) -> None:
        i18n = get_i18n(member.locale)
        if any(key in frame for key in ("character", "target", "name", "user_id")):
            await member.send_frame(error_frame("forbidden", i18n))
            return
        sha256 = str(frame.get("hash") or "").lower()
        try:
            record = await self.media_store.get_record(member.session_key, sha256)
            if record is None:
                await member.send_frame(error_frame("media_not_found", i18n))
                return
            if not is_image_mime(record.mime):
                await member.send_frame(error_frame("media_bad_mime", i18n))
                return
            await set_user_avatar(
                self.services,
                user_id=member.id,
                chat_key=member.session_key,
                avatar=record.ref(),
            )
        except AvatarError as exc:
            await member.send_frame(error_frame(exc.code, i18n))
            return
        await member.send_frame({"type": "system", "level": "info", "text": i18n.t("tui.avatar.set_done")})
        await publish_state(self.hub, self.services, self._ctx_for(member))

    def drop_pending_media(self, member: Any) -> None:
        """Forget offers `member` never completed — a PUT can only arrive on its own connection,
        so its pending entries are dead once that connection closes. (Transports call this on
        disconnect; without it the offer→never-PUT pattern grows `_pending_media` forever.)"""
        stale = [
            upload_id
            for upload_id, pending in self._pending_media.items()
            if pending.room == member.session_key and pending.uploader == member.id
        ]
        for upload_id in stale:
            self._pending_media.pop(upload_id, None)

    def _drop_pending_room(self, session_key: str) -> None:
        """Invalidate every uncommitted offer before replacing/deleting room state."""
        stale = [
            upload_id
            for upload_id, pending in self._pending_media.items()
            if pending.room == session_key
        ]
        for upload_id in stale:
            self._pending_media.pop(upload_id, None)

    async def receive_media_put(self, member: Any, upload_id: str, data: bytes) -> dict[str, Any]:
        i18n = get_i18n(member.locale)
        async with self.hub.turn_lock(member.session_key):
            if not self._refresh_member_authorization(member):
                raise MediaError("forbidden")
            pending = self._pending_media.pop(upload_id, None)
            if pending is None or pending.room != member.session_key or pending.uploader != member.id:
                raise MediaError("media_bad_upload")
            try:
                record = await self.media_store.commit_bytes(pending, data)
            except MediaError:
                raise
            except Exception as exc:
                raise MediaError("server_error") from exc
            if is_audio_mime(record.mime):
                await self._publish_audio_item(member, record)
                return {
                    "type": "media_put_ok",
                    "hash": record.hash,
                    "message": i18n.t("tui.media.uploaded", name=record.name),
                }
            media_frame = self._media_frame(record, member)
            await self._publish_media(member, media_frame)
            return {
                "type": "media_put_ok",
                "hash": record.hash,
                "message": i18n.t("tui.media.uploaded", name=record.name),
            }

    async def get_media_bytes(self, member: Any, sha256: str) -> tuple[dict[str, Any], bytes]:
        """Resolve one byte-channel GET: room media first, then (v1.8) installed-pack
        assets of packs ENABLED in the caller's room — the same content-addressed reply
        either way, and never an arbitrary blob oracle (an un-enabled pack's hashes stay
        `media_not_found` here exactly like a hash from another room)."""
        if not self._refresh_member_authorization(member):
            raise MediaError("forbidden")
        try:
            record, data = await self.media_store.read_bytes(member.session_key, sha256)
        except MediaError as exc:
            if exc.code != "media_not_found":
                raise
            from gateway.panels import resolve_pack_asset

            resolved = await resolve_pack_asset(self.services, member.session_key, sha256)
            if resolved is None:
                raise
            asset_data, mime, name = resolved
            header = {
                "op": "get",
                "hash": sha256.lower(),
                "size": len(asset_data),
                "mime": mime,
                "name": name,
            }
            return header, asset_data
        header = {
            "op": "get",
            "hash": record.hash,
            "size": record.size,
            "mime": record.mime,
            "name": record.name,
        }
        return header, data

    def _media_frame(self, record: MediaRecord, member: Any) -> dict[str, Any]:
        return media_frame(record, from_name=getattr(member, "name", "") or record.uploader, frame_id=new_id())

    async def _publish_media(self, member: Any, frame: dict[str, Any]) -> None:
        await record_media_history(self.services.store, member.session_key, frame)
        await self.hub.publish(member.session_key, Event.media(frame))

    async def _publish_audio_item(self, member: Any, record: MediaRecord) -> dict[str, Any]:
        frame = await add_audio_item(
            self.services.store,
            member.session_key,
            record,
            getattr(member, "name", "") or record.uploader,
        )
        await self.hub.publish(member.session_key, Event.audio(frame))
        return frame

    async def dispatch_input(self, member: Any, text: str) -> None:
        """Drive one player turn (command or AI-KP) to completion via the hub.

        Rate-limiting and per-connection error frames stay here (transport concerns); the turn
        itself and its room fan-out are `run_turn`'s job.
        """
        i18n = get_i18n(member.locale)
        if not self._refresh_member_authorization(member):
            await member.send_frame(error_frame("forbidden", i18n))
            return
        if not self.rate_limiter.allow(member.id) or not self.rate_limiter.allow(member.session_key):
            await member.send_frame(error_frame("rate_limited", i18n))
            return

        try:
            # Serialize the WHOLE turn per room (F8): two connections in the same room must not
            # interleave their read-modify-write of the shared per-room state. `run_turn` publishes
            # a companion sub-turn inline (re-entering `run_turn`, not this choke), so no re-lock.
            # The previous turn's Scribe is awaited at `run_kp_turn` (prompt assembly), not
            # here: this choke also admits `.undo` / reset / import, which cancel-and-drain
            # the chain at their mutation entries (`agent.undo.restore`, `net.room_backup`).
            lock = self.hub.turn_lock(member.session_key)
            if lock.locked():
                notify_turn_queued(member, i18n)
            async with lock:
                # A queued turn must not retain authority from before it waited. This also
                # refreshes `member.role` before `_ctx_for` copies it into command privileges.
                if not self._refresh_member_authorization(member):
                    await member.send_frame(error_frame("forbidden", i18n))
                    return
                ctx = self._ctx_for(member)
                # The fallback responder retains one exact legacy CLI setup action. Guard that
                # explicit action too, but never infer destructive setup from ordinary prose
                # merely containing words such as "upload" or "module". Real commands such as
                # `.module list` resolve before this fallback-only compatibility check.
                guarded_demo_setup = is_guided_demo_action(text) or (
                    uses_demo_llm(self.services)
                    and self.command_router.resolve(text, member.locale) is None
                    and is_demo_setup_request(text)
                )
                if guarded_demo_setup and (
                    getattr(member, "role", "") != "keeper"
                    or not await guided_demo_available(self.services, member.session_key)
                ):
                    await member.send_frame(error_frame("demo_unavailable", i18n))
                    return
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
        `extra["role"]` so `gateway.commands.rooms._privilege_level` gates keeper-only dot-commands by the
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
            extra={
                "role": member.role,
                # Hub filters use Member.user_key, which is transport-qualified
                # and is not necessarily identical to AgentCtx.user_id.
                "member_user_key": member.user_key,
                "reauthorize": lambda: self._refresh_member_authorization(member),
            },
        )
