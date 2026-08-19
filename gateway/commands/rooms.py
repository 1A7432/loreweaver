"""Rooms and room lifecycle: `.room` / `.bind` / `.unbind`, `.reset` (with its confirmation
window), `.undo`, `.save`, `.bot`, `.botlist`, `.dev` — and the privilege helpers every
keeper-only command gates on (`_is_keeper`, `_privilege_level`)."""

from __future__ import annotations

import logging
import time
from typing import Any

from agent.chronicle import CHRONICLE_TURN_KEY, chronicle_turn
from agent.context import AgentCtx
from agent.undo import available_turns, undo_depth
from agent.undo import restore as restore_room
from gateway.commands.types import CommandCtx
from gateway.ops import (
    PrivilegeLevel,
    set_bot_enabled,
)
from gateway.rooms import (
    clear_binding,
    clear_keeper_binding,
    get_binding,
    get_keeper_binding,
    mint_room_id,
    session_key_for_room,
    set_binding,
    set_keeper_binding,
)
from gateway.turn import publish_state
from infra.room_facets import RESET_SCOPES, STORAGE_ROOM_STATE, RoomStateFacet

logger = logging.getLogger(__name__)

# `.room` subcommand vocabularies (EN + a couple of CN synonyms).
_ROOM_OPEN_WORDS = {"open", "new", "create", "开", "开房", "開", "開房"}
_ROOM_LINK_WORDS = {"link", "join", "bind", "连", "連", "加入"}
_RESET_CONFIRM_WORDS = {"confirm", "yes", "确认", "確認"}
_RESET_CONFIRM_WINDOW_SECONDS = 120
# `.reset [scope]` — how much of the campaign to wipe (see net.room_backup.reset_room_state).
# Bare `.reset` is the lightest "story only" scope; the wider scopes are opt-in words.
_RESET_SCOPE_WORDS = {
    "": "story",
    "story": "story",
    "剧情": "story",
    "劇情": "story",
    "char": "chars",
    "chars": "chars",
    "character": "chars",
    "characters": "chars",
    "角色": "chars",
    "换角色": "chars",
    "換角色": "chars",
    "all": "all",
    "full": "all",
    "everything": "all",
    "全部": "all",
    "全清": "all",
}
# The ladder itself is single-sourced (M23 WS1): this file maps WORDS onto it, and the
# scopes those words name are the engine's, not a second copy that can drift.
_RESET_SCOPES = RESET_SCOPES


def _parse_reset_pending(raw: str | None) -> tuple[float, str | None]:
    """Decode the `reset_pending` marker (`"<epoch>:<scope>"`) into (armed_at, scope)."""
    if not raw:
        return 0.0, None
    ts, _, scope = raw.partition(":")
    try:
        armed_at = float(ts)
    except ValueError:
        return 0.0, None
    return (armed_at, scope) if scope in _RESET_SCOPES else (0.0, None)
_ROOM_LEAVE_WORDS = {"leave", "unbind", "close", "离开", "離開", "解绑", "解綁"}
_ROOM_SHOW_WORDS = {"", "show", "status", "info", "查看"}

# `.botlist` subcommand vocabularies (EN + a couple of CN synonyms) -- anti-loop
# bot-ignore list (`gateway.ops.Botlist`).
_BOTLIST_ADD_WORDS = {"add", "new", "添加", "新增"}
_BOTLIST_REMOVE_WORDS = {"remove", "rm", "del", "delete", "移除", "删除", "刪除"}
_BOTLIST_LIST_WORDS = {"", "list", "ls", "show", "列表", "查看"}
_SAVE_LOAD_WORDS = {"load", "restore", "读档", "讀檔", "载入", "載入"}

_ROOM_ADMIN_CHAT_TYPES = {"dm", "direct", "private", "c2c"}

# TOPOLOGY, not privilege: platforms whose channel is inherently local/private rather
# than a public chat group (used e.g. by `_is_private_channel` to decide whether
# echoing a secret like an API key back inline is safe). Membership here does NOT by
# itself grant any privilege level — see `_AUTO_MASTER_PLATFORMS` / `_privilege_level`
# for who is actually authorized to run keeper-only commands on each platform.
_ROOM_LOCAL_PLATFORMS = {"cli", "tui"}

# PRIVILEGE: platforms that are a single, already-trusted local operator process with
# no keystore/role concept, so the caller is always the master. `tui` is deliberately
# excluded: it is a genuine multi-user network service (`net/tui_server.py`), so its
# privilege must instead be decided per-connection from the authenticated keystore role
# stamped into `ctx.extra["role"]` (see `_privilege_level`), never assumed from the
# platform name alone.
_AUTO_MASTER_PLATFORMS = {"cli"}
_TUI_KEEPER_ROLE = "keeper"


def _channel_chat_key(ctx: Any) -> str:
    """The ORIGIN channel's chat_key (for room bindings), even when `ctx.chat_key`
    has already been resolved to a shared session by the runner."""
    extra = getattr(ctx, "extra", None)
    source = extra.get("source") if isinstance(extra, dict) else None
    if source is not None and hasattr(source, "chat_key"):
        return str(source.chat_key())
    chat_key = getattr(ctx, "chat_key", "")
    return chat_key() if callable(chat_key) else str(chat_key)


def _origin_source(ctx: Any) -> Any | None:
    extra = getattr(ctx, "extra", None)
    return extra.get("source") if isinstance(extra, dict) else None


def _is_direct_chat(source: Any) -> bool:
    return bool(getattr(source, "user_id", None)) and str(
        getattr(source, "chat_type", "") or ""
    ).casefold() in _ROOM_ADMIN_CHAT_TYPES


def _privilege_level(ctx: Any) -> int:
    """The caller's privilege for command gating (see `_ROOM_*` constants).

    Local CLI is trusted; every network transport needs an authenticated Keeper role."""
    platform = str(getattr(ctx, "platform", "") or "").casefold()
    if platform in _AUTO_MASTER_PLATFORMS:
        return int(PrivilegeLevel.MASTER)
    extra = getattr(ctx, "extra", None)
    role = extra.get("role") if isinstance(extra, dict) else None
    if role == _TUI_KEEPER_ROLE:
        return int(PrivilegeLevel.MASTER)
    return int(PrivilegeLevel.EVERYONE)


def _is_keeper(ctx: Any) -> bool:
    """True for the local operator or an authenticated keeper identity."""
    platform = str(getattr(ctx, "platform", "") or "").casefold()
    if platform in _AUTO_MASTER_PLATFORMS:
        return True
    extra = getattr(ctx, "extra", None)
    return isinstance(extra, dict) and extra.get("role") == _TUI_KEEPER_ROLE


async def _keeper_still_authorized(ctx: Any, chat_key: str, store: Any) -> bool:
    platform = str(getattr(ctx, "platform", "") or "").casefold()
    if platform in _AUTO_MASTER_PLATFORMS:
        return True
    if not _is_keeper(ctx):
        return False
    source = _origin_source(ctx)
    if source is None or platform in {"tui", "iroh"}:
        extra = getattr(ctx, "extra", None)
        reauthorize = extra.get("reauthorize") if isinstance(extra, dict) else None
        return bool(reauthorize()) if callable(reauthorize) else True
    room = await get_keeper_binding(
        store,
        source.platform,
        source.user_id,
    )
    return bool(room and session_key_for_room(room) == chat_key)


def _is_private_channel(ctx: Any) -> bool:
    """True for the local CLI/TUI operator or a private/DM channel — where echoing
    a secret (e.g. an API key) back is acceptable."""
    platform = str(getattr(ctx, "platform", "") or "").casefold()
    if platform in _ROOM_LOCAL_PLATFORMS:
        return True
    extra = getattr(ctx, "extra", None)
    if isinstance(extra, dict) and extra.get("private_interaction"):
        return True
    source = extra.get("source") if isinstance(extra, dict) else None
    chat_type = str(getattr(source, "chat_type", "") or "").casefold()
    return chat_type in _ROOM_ADMIN_CHAT_TYPES


def _member_label(member: Any) -> str:
    return str(getattr(member, "name", "") or getattr(member, "id", "") or "")


# --- Room lifecycle (M23 WS1) -----------------------------------------------
ROOM_FACETS = (
    RoomStateFacet(
        name="reset_confirmation",
        owner="gateway.commands.rooms",
        reset_scope=None,
        survives_because=(
            "a two-minute confirmation marker armed by `.reset` and consumed by the "
            "`confirm` that follows; it expires by timestamp, so surviving the very reset "
            "it authorised costs nothing and clearing it mid-operation would be surgery "
            "on the operation's own trigger"
        ),
        state_keys=frozenset({"reset_pending"}),
        storages=frozenset({STORAGE_ROOM_STATE}),
    ),
)


class RoomsCommands:
    """`CommandRouter` mixin — see the module docstring."""

    async def cmd_bot_toggle(self, ctx: CommandCtx) -> str:
        """`.bot [on|off]` — mute/unmute the AI Keeper room-wide. The bare status
        query is open to anyone, but flipping ``bot_enabled`` is a room-wide control
        (a muted Keeper stops responding for EVERY member), so on/off require a keeper.
        Gated in-handler (not via ``required_level``) so a CLI/TUI keeper keeps working
        while a plain networked player cannot silence the table."""
        value = ctx.args.strip().casefold()
        if value in {"on", "1", "true", "开启", "啟用"}:
            if not _is_keeper(ctx.raw_ctx):
                return ctx.fail(ctx.i18n.t("rooms.denied"))
            await set_bot_enabled(ctx.services.store, ctx.chat_key, True)
            return ctx.i18n.t("commands.bot.on")
        if value in {"off", "0", "false", "关闭", "關閉"}:
            if not _is_keeper(ctx.raw_ctx):
                return ctx.fail(ctx.i18n.t("rooms.denied"))
            await set_bot_enabled(ctx.services.store, ctx.chat_key, False)
            return ctx.i18n.t("commands.bot.off")
        return ctx.i18n.t("commands.bot.status")

    async def cmd_botlist(self, ctx: CommandCtx) -> str:
        """`.botlist [add|remove|list] <bot_id>` — maintain the anti-loop bot-ignore
        list (`gateway.ops.Botlist`) that `GatewayRunner.on_inbound` consults on every
        inbound message. `<bot_id>` is a `SessionSource.user_key()` value, i.e.
        `"{platform}:{user_id}"` (e.g. `onebot:114514`) — the SAME identity string the
        runner derives from every inbound message, so an id copied from `.room`/a
        platform's own member list matches directly.

        Discord marks bot authors natively via `SessionSource.is_bot`; Telegram
        does so only for ordinary bot posts (anonymous-admin/linked-channel
        posts arrive as `sender_chat` without an `is_bot` marker and are NOT
        flagged). This command is the reliable cover for those gaps and for
        platforms without any native flag (QQ, OneBot), and provides an
        explicit override for every platform.
        """
        if ctx.raw_ctx.platform != "cli":
            return ctx.fail(ctx.i18n.t("rooms.denied"))
        parts = ctx.args.split(maxsplit=1)
        sub = parts[0].casefold() if parts else ""
        rest = parts[1].strip() if len(parts) > 1 else ""
        if sub in _BOTLIST_ADD_WORDS:
            if not rest:
                return ctx.i18n.t("commands.botlist.usage")
            self.botlist.add(rest)
            return ctx.i18n.t("commands.botlist.added", id=rest)
        if sub in _BOTLIST_REMOVE_WORDS:
            if not rest:
                return ctx.i18n.t("commands.botlist.usage")
            self.botlist.remove(rest)
            return ctx.i18n.t("commands.botlist.removed", id=rest)
        if sub in _BOTLIST_LIST_WORDS:
            ids = self.botlist.list_ids()
            if not ids:
                return ctx.i18n.t("commands.botlist.empty")
            return ctx.i18n.t("commands.botlist.show", ids=", ".join(ids))
        return ctx.i18n.t("commands.botlist.usage")

    async def cmd_undo(self, ctx: CommandCtx) -> str:
        """`.undo [n]` — rewind the room by `n` turns (default 1). Keeper only.

        Shallow by design and capped at the chronicle's no-future lag window: a real table
        rewinds the last thing that happened, and capping inside that window makes a
        conflict with the rolling summary structurally impossible — those turns have not
        been folded yet. Both halves of the room move together (documents + room_state +
        the history leaf), so the conversation the Keeper replays and the state its tools
        read are the same moment.
        """
        if not _is_keeper(ctx.raw_ctx):
            return ctx.fail(ctx.i18n.t("commands.undo.denied"))
        raw = ctx.args.strip()
        try:
            steps = int(raw) if raw else 1
        except ValueError:
            return ctx.i18n.t("commands.undo.usage")
        depth = undo_depth(ctx.services)
        if steps < 1 or steps > depth:
            return ctx.i18n.t("commands.undo.too_deep", depth=depth)

        current = await chronicle_turn(ctx.services.store, ctx.chat_key)
        target = current - steps
        available = await available_turns(ctx.services, ctx.chat_key)
        if target < 0 or (target > 0 and target not in available):
            return ctx.i18n.t("commands.undo.unavailable", turns=", ".join(str(t) for t in sorted(available)) or "-")

        # A rewind rewrites what every other member is looking at. Serialization against
        # an in-flight turn comes from the transport choke point (net/session.py,
        # gateway/runner.py), which holds the room's turn lock around this whole command
        # dispatch already — re-acquiring `hub.turn_lock` HERE wedged the room forever:
        # the lock is not reentrant and its holder was this very task, so the second
        # acquire waited on itself and every later turn queued behind it.
        if target == 0:
            from net.room_backup import reset_room_state

            await reset_room_state(ctx.services, ctx.chat_key, scope="story")
        elif not await restore_room(ctx.services, ctx.chat_key, target):
            return ctx.i18n.t("commands.undo.unavailable", turns="-")
        await ctx.services.store.state_set(ctx.chat_key, CHRONICLE_TURN_KEY, str(target))
        # A restore rewinds EVERYONE, so a fresh state frame flagged reset=True goes out:
        # every connected client refreshes its panel AND drops its now-wrong local
        # scrollback at once, exactly as `.reset` does.
        await self._publish_reset(ctx)
        return ctx.i18n.t("commands.undo.done", turns=steps, turn=target)

    async def _publish_reset(self, ctx: CommandCtx) -> None:
        """Broadcast a reset-flagged state frame, the way `.reset` does. No hub, no-op."""
        if self.hub is None:
            return
        await publish_state(
            self.hub,
            ctx.services,
            AgentCtx(
                chat_key=ctx.chat_key,
                user_id=ctx.user_id,
                platform=str(getattr(ctx.raw_ctx, "platform", "cli") or "cli"),
                locale=ctx.locale,
            ),
            reset=True,
        )

    async def cmd_save(self, ctx: CommandCtx) -> str:
        """`.save [name]` / `.save load <name>` — named full-room checkpoints. Keeper only.

        Deliberately the SAME operation `net.room_backup` already performs for the admin
        export/import frames, reached from a nicer place. Its snapshot carries documents,
        room_state, the history tree, store rows, vectors, media AND the room's bearer
        keys, which is what makes it a whole-room checkpoint that cannot produce the
        "state at turn 30, summary at turn 190" tear — and is also why the keeper gate and
        the backups-directory confinement carry over unchanged. This command is a nicer
        trigger for an existing operation and nothing more: it must not widen who can
        reach a snapshot file.

        `keystore` is the room's bearer-key registry, injected by the transport that owns
        one. Without it there is no whole-room checkpoint to take, so the command says so
        rather than writing a snapshot with the keys silently missing.
        """
        if not _is_keeper(ctx.raw_ctx):
            return ctx.fail(ctx.i18n.t("commands.save.denied"))
        keystore = self.keystore
        if keystore is None:
            return ctx.fail(ctx.i18n.t("commands.save.unavailable"))
        from net.room_backup import export_room, import_room, room_for_chat_key

        parts = ctx.args.split(maxsplit=1)
        sub = parts[0].casefold() if parts else ""
        rest = parts[1].strip() if len(parts) > 1 else ""
        room = room_for_chat_key(ctx.chat_key)
        try:
            if sub in _SAVE_LOAD_WORDS:
                if not rest:
                    return ctx.i18n.t("commands.save.usage")
                # Serialized by the transport choke point's turn lock, exactly like
                # `.undo` above — a command handler must never re-take the room's own
                # lock (not reentrant; the holder is this task).
                result = await import_room(ctx.services, keystore, rest, expected_room=room)
                await self._publish_reset(ctx)
                return ctx.i18n.t("commands.save.loaded", name=rest, documents=result.get("documents", 0))
            result = await export_room(ctx.services, keystore, room, ctx.args.strip())
            return ctx.i18n.t("commands.save.done", path=str(result.get("path", "")))
        except Exception as exc:  # noqa: BLE001 — a save must report, never crash the room
            logger.warning("room save/load failed for %s", ctx.chat_key, exc_info=True)
            return ctx.i18n.t("commands.save.failed", error=str(exc))

    async def cmd_bind(self, ctx: CommandCtx) -> str:
        """Consume a one-time keeper token in a bot private chat."""
        source = _origin_source(ctx.raw_ctx)
        if source is None or not _is_direct_chat(source):
            return ctx.i18n.t("commands.bind.private_only")
        if self.keystore is None:
            return ctx.i18n.t("commands.bind.unavailable")
        token = ctx.args.strip()
        if not token:
            return ctx.i18n.t("commands.bind.usage")
        entry = self.keystore.consume(token, purpose="chat_bind", required_role="keeper")
        if entry is None:
            return ctx.i18n.t("commands.bind.invalid")

        await set_keeper_binding(
            ctx.services.store,
            str(source.platform),
            str(source.user_id),
            entry.room,
        )
        return ctx.i18n.t("commands.bind.done", room=entry.room)

    async def cmd_unbind(self, ctx: CommandCtx) -> str:
        """Revoke this chat identity's keeper binding and leave its private room."""
        source = _origin_source(ctx.raw_ctx)
        if source is None or not _is_direct_chat(source):
            return ctx.i18n.t("commands.bind.private_only")
        binding = await get_keeper_binding(
            ctx.services.store,
            str(source.platform),
            source.user_id,
        )
        await clear_keeper_binding(
            ctx.services.store,
            str(source.platform),
            source.user_id,
            expected_room=binding,
        )
        if binding is None:
            return ctx.i18n.t("commands.unbind.none")
        return ctx.i18n.t("commands.unbind.done", room=binding)

    async def cmd_room(self, ctx: CommandCtx) -> str:
        """`.room [open|link <key>|leave]` — bind/inspect this channel's shared
        session (M7 §4). Bindings are keyed by the ORIGIN channel's chat_key, not
        the (already-resolved) `ctx.chat_key`, so `resolve_session_key` finds
        them on the next inbound message."""
        parts = ctx.args.split(maxsplit=1)
        sub = parts[0].casefold() if parts else ""
        rest = parts[1].strip() if len(parts) > 1 else ""
        channel_key = _channel_chat_key(ctx.raw_ctx)
        store = ctx.services.store
        if sub in _ROOM_OPEN_WORDS:
            if not _is_keeper(ctx.raw_ctx):
                return ctx.fail(ctx.i18n.t("rooms.denied"))
            if not _is_private_channel(ctx.raw_ctx):
                return ctx.i18n.t("rooms.private_required")
            return await self._room_open(ctx, store, channel_key)
        if sub in _ROOM_LINK_WORDS:
            # Linking this channel into a shared session redirects the whole
            # channel's traffic; keeper-only, consistent with open/leave.
            if not _is_keeper(ctx.raw_ctx):
                return ctx.fail(ctx.i18n.t("rooms.denied"))
            return await self._room_link(ctx, store, channel_key, rest)
        if sub in _ROOM_LEAVE_WORDS:
            if not _is_keeper(ctx.raw_ctx):
                return ctx.fail(ctx.i18n.t("rooms.denied"))
            return await self._room_leave(ctx, store, channel_key)
        if sub in _ROOM_SHOW_WORDS:
            return await self._room_show(ctx, store, channel_key)
        return ctx.i18n.t("rooms.usage")

    async def _room_open(self, ctx: CommandCtx, store: Any, channel_key: str) -> str:
        if self.keystore is None:
            return ctx.i18n.t("rooms.open.no_keystore")
        room_id = mint_room_id()
        session_key = session_key_for_room(room_id)
        # A returned join key must already be authoritative on disk. SessionCore revalidates
        # every live member against the file-backed keystore, so an in-memory-only key would
        # authenticate once and then be rejected on its first frame (and disappear on restart).
        with self.keystore.persisted_mutation():
            join_key = self.keystore.add(room=room_id)
        await set_binding(store, channel_key, session_key)
        return ctx.i18n.t("rooms.open.result", key=join_key, session=session_key)

    async def _room_link(self, ctx: CommandCtx, store: Any, channel_key: str, rest: str) -> str:
        if not rest:
            return ctx.i18n.t("rooms.link.usage")
        session_key = self._room_link_target(rest)
        if session_key is None:
            # A token that is not a known keystore join key is refused outright: no
            # binding, no leak. (Accepting a literal session id here would let a caller
            # bind their channel to an arbitrary FOREIGN session and read/eavesdrop it.)
            return ctx.i18n.t("rooms.link.invalid_key")
        await set_binding(store, channel_key, session_key)
        return ctx.i18n.t("rooms.link.result", session=session_key)

    def _room_link_target(self, token: str) -> str | None:
        """Resolve a keystore join KEY to its terminal session, or ``None`` if
        ``token`` is not a known join key.

        Only a real join key (minted by ``.room open`` and handed to invitees) may
        bind a channel to a shared session — there is deliberately NO literal
        session-id fallback, which would otherwise let anyone bind to (and read /
        eavesdrop) an arbitrary foreign session by guessing its id."""
        if self.keystore is not None:
            try:
                # Operations may revoke or move a key while the bot process stays up. Never
                # authorize `.room link` from a stale in-memory snapshot.
                self.keystore.refresh()
            except Exception:
                return None
            entry = self.keystore.get(token)
            if entry is not None:
                return session_key_for_room(entry.room)
        return None

    async def _room_leave(self, ctx: CommandCtx, store: Any, channel_key: str) -> str:
        binding = await get_binding(store, channel_key)
        if not binding:
            return ctx.i18n.t("rooms.leave.none")
        await clear_binding(store, channel_key)
        return ctx.i18n.t("rooms.leave.result", session=binding)

    async def _room_show(self, ctx: CommandCtx, store: Any, channel_key: str) -> str:
        binding = await get_binding(store, channel_key)
        if not binding:
            return ctx.i18n.t("rooms.show.none")
        online = 0
        members_text = ctx.i18n.t("rooms.show.empty")
        if self.hub is not None:
            members = self.hub.members(binding)
            online = len(members)
            names = sorted(n for n in (_member_label(member) for member in members) if n)
            if names:
                members_text = ", ".join(names)
        return ctx.i18n.t("rooms.show.result", session=binding, online=online, members=members_text)

    async def cmd_reset(self, ctx: CommandCtx) -> str:
        """`.reset [chars|all]` then `.reset confirm` — restart the campaign in
        place. `.reset` clears only the story/progress (keeping characters, the
        module, lore and media); `.reset chars` also rolls new characters (keeping
        the module); `.reset all` erases everything. Room settings (language, house
        rules) always survive, as do keys, bindings and connections. There is NO
        backup, hence the keeper gate plus a persisted two-step confirm."""
        store = ctx.services.store
        if not await _keeper_still_authorized(ctx.raw_ctx, ctx.chat_key, store):
            return ctx.fail(ctx.i18n.t("commands.reset.denied"))
        pending_key = "reset_pending"
        arg = ctx.args.strip().casefold()
        if arg in _RESET_CONFIRM_WORDS:
            armed_at, armed_scope = _parse_reset_pending(
                await store.state_get(ctx.chat_key, pending_key)
            )
            if armed_scope is not None and time.time() - armed_at <= _RESET_CONFIRM_WINDOW_SECONDS:
                # The reset itself lives beside the backup/delete machinery so the
                # room-state key vocabulary stays single-sourced (same gateway->net
                # seam as gateway/turn.py's `net.state` import).
                from net.room_backup import reset_room_state

                try:
                    result = await reset_room_state(
                        ctx.services, ctx.chat_key, scope=armed_scope, keystore=self.keystore
                    )
                except Exception:
                    logger.exception("campaign reset failed for %s", ctx.chat_key)
                    return ctx.i18n.t("commands.reset.failed")
                await store.state_delete(ctx.chat_key, pending_key)
                # Push a fresh state frame flagged reset=True so every connected client
                # refreshes its info panel AND drops its stale local chat scrollback at
                # once, instead of waiting for the next turn.
                if self.hub is not None:
                    await publish_state(
                        self.hub,
                        ctx.services,
                        AgentCtx(
                            chat_key=ctx.chat_key,
                            user_id=ctx.user_id,
                            platform=str(getattr(ctx.raw_ctx, "platform", "cli") or "cli"),
                            locale=ctx.locale,
                        ),
                        reset=True,
                    )
                return ctx.i18n.t(
                    "commands.reset.done",
                    what=ctx.i18n.t(f"commands.reset.scope.{armed_scope}"),
                    rows=int(result.get("store_rows") or 0),
                )
            return ctx.i18n.t("commands.reset.usage")
        # Bare `.reset` or `.reset <scope>` arms the pending window with that scope.
        scope = _RESET_SCOPE_WORDS.get(arg)
        if scope is None:
            return ctx.i18n.t("commands.reset.usage")
        await store.state_set(ctx.chat_key, pending_key, f"{time.time()}:{scope}")
        return ctx.i18n.t(
            "commands.reset.armed",
            what=ctx.i18n.t(f"commands.reset.scope.{scope}"),
            seconds=_RESET_CONFIRM_WINDOW_SECONDS,
        )

    async def cmd_dev(self, ctx: CommandCtx) -> str:
        """`.dev [status|mount <path>|unmount|reload]` — author dev rooms (`gateway.dev_room`):
        live-reload a pack SOURCE dir into this room. Keeper-only, and the whole surface is
        off unless `TRPG_DEV__SOURCE_ROOT` confines where mounts may point (a server path
        read, so it gets the networked-admin posture, not just a keeper check)."""
        from gateway import dev_room

        if not _is_keeper(ctx.raw_ctx):
            return ctx.fail(ctx.i18n.t("dev.commands.denied"))
        tokens = ctx.args.split(maxsplit=1)
        sub = tokens[0].casefold() if tokens else "status"
        rest = tokens[1].strip() if len(tokens) > 1 else ""
        hub = self.hub
        if sub in {"mount", "挂载", "掛載"}:
            if not rest:
                return ctx.i18n.t("dev.commands.usage")
            return await dev_room.mount(ctx.services, hub, ctx.chat_key, rest, ctx.locale)
        if sub in {"unmount", "卸载", "卸載"}:
            had = await dev_room.unmount(ctx.services, ctx.chat_key)
            return ctx.i18n.t("dev.commands.unmounted" if had else "dev.commands.not_mounted")
        if sub in {"reload", "重载", "重載"}:
            if await dev_room.rearm(ctx.services, hub, ctx.chat_key) is None:
                return ctx.i18n.t("dev.commands.not_mounted")
            return await dev_room.reload(ctx.services, hub, ctx.chat_key, ctx.locale)
        if sub in {"status", "状态", "狀態"}:
            state = await dev_room.rearm(ctx.services, hub, ctx.chat_key)
            if state is None:
                return ctx.i18n.t("dev.commands.not_mounted")
            return ctx.i18n.t("dev.commands.status", pack=state.pack_id, path=str(state.path))
        return ctx.i18n.t("dev.commands.usage")
