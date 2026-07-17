"""Gateway runner: deterministic pre-layer, command dispatch, and AI-KP turns."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.loop import run_kp_turn
from agent.services import Services
from agent.tools import Toolset
from gateway.attachment_fs import AttachmentFs
from gateway.audio import add_audio_item
from gateway.base_adapter import BaseAdapter
from gateway.chat import ChatAttachment, ChatComponent, ChatMessage
from gateway.commands import CommandRouter, CommandSpec
from gateway.events import InboundMessage
from gateway.hub import Event, RoomHub
from gateway.media import media_frame, record_media_history
from gateway.member import AdapterMember
from gateway.ops import Botlist, Censor, RateLimiter, censor_from_settings
from gateway.rooms import (
    get_keeper_binding,
    resolve_session_key,
    session_key_for_room,
)
from gateway.session import SessionSource
from gateway.turn import run_turn
from infra.i18n import get_i18n
from infra.media_store import (
    ALLOWED_AUDIO_MIMES,
    ALLOWED_CHAT_ATTACHMENT_MIMES,
    ALLOWED_IMAGE_MIMES,
    MediaStore,
    is_audio_mime,
)

logger = logging.getLogger(__name__)

_BOT_ENABLED_PREFIX = "bot_enabled."
_BOT_ENABLED_VALUE = "1"
_BOT_DISABLED_VALUE = "0"
_CHAT_LOCALE_KEYS = ("chat_locale.{chat_key}", "locale.{chat_key}")
_DIRECT_CHAT_TYPES = {"dm", "direct", "private", "c2c"}
_COMMAND_PREFIXES = (".", "。", "/")


class GatewayRunner:
    def __init__(
        self,
        services: Services,
        adapters: list[BaseAdapter] | None = None,
        *,
        command_router: CommandRouter | None = None,
        toolset: Toolset | None = None,
        hub: RoomHub | None = None,
        keystore: Any = None,
        censor: Censor | None = None,
    ) -> None:
        self.services = services
        self.adapters = list(adapters or [])
        # Network adapters share a hub; the local CLI uses the direct reply path.
        self.hub = hub
        self.keystore = keystore
        self.command_router = command_router or CommandRouter(services, keystore=keystore, hub=hub)
        self.toolset = toolset
        self.rate_limiter = RateLimiter()
        # Built from `services.settings.censor` (see `infra.config.CensorSettings` /
        # `docs/deploy.md` "Content moderation") unless a caller injects one (tests).
        # With nothing configured this is an explicit no-op, not a fake wordlist.
        self.censor = censor if censor is not None else censor_from_settings(services.settings.censor)
        # The SAME Botlist instance `.botlist add` (`CommandRouter.cmd_botlist`)
        # mutates -- never a separate copy, or a runtime addition would silently not
        # take effect on this pre-LLM gate. See `gateway.ops.Botlist` for why this
        # manual list exists alongside the platform-native `source.is_bot` check below.
        # `getattr` falls back to a private, empty `Botlist` for a non-`CommandRouter`
        # test double injected as `command_router` (no `.botlist` attribute) so those
        # tests are unaffected; production always goes through a real `CommandRouter`.
        self.botlist = getattr(self.command_router, "botlist", None) or Botlist()
        # Per-channel AdapterMember registry (keyed by the channel's own
        # chat_key) so repeat messages from a channel reuse one hub member.
        self._members: dict[str, AdapterMember] = {}
        tui = services.settings.tui
        self.media_store = MediaStore(
            services.store,
            services.settings.data_dir,
            max_file_bytes=tui.media_max_file_bytes,
            room_quota_bytes=tui.media_room_quota_bytes,
            allowed_mimes=ALLOWED_IMAGE_MIMES,
        )
        self.audio_store = MediaStore(
            services.store,
            services.settings.data_dir,
            max_file_bytes=tui.audio_max_file_bytes,
            room_quota_bytes=tui.audio_room_quota_bytes,
            allowed_mimes=ALLOWED_AUDIO_MIMES,
        )

    async def on_inbound(self, msg: InboundMessage) -> ChatMessage | None:
        source = msg.source
        channel_key = source.chat_key()
        chat_key = (
            await resolve_session_key(self.services.store, source)
            if self.hub is not None
            else channel_key
        )
        user_key = source.user_key()
        keeper_role = await self._keeper_role(source, chat_key)
        ctx_extra = {"source": source, "raw": msg.raw or {}}
        if msg.interaction is not None and msg.interaction.private:
            ctx_extra["private_interaction"] = True
        if keeper_role is not None:
            ctx_extra["role"] = keeper_role

        if source.is_bot or self.botlist.is_bot(user_key):
            return None

        preferred_locale = msg.interaction.locale if msg.interaction is not None else ""
        locale = await self._locale_for(chat_key, preferred=preferred_locale)
        ctx = AgentCtx(
            chat_key=chat_key,
            user_id=user_key,
            platform=source.platform,
            locale=locale,
            fs=self._fs_for(source.platform),
            extra=ctx_extra,
        )

        text = self._normalize_cli_command_text(msg.text, locale, source.platform)
        command = self._resolve_command(text, locale)
        is_command = command is not None
        if command is None and msg.quoted_text.strip():
            quote = "\n".join(f"> {line}" for line in msg.quoted_text.strip().splitlines())
            text = f"{quote}\n\n{text}".rstrip()

        bot_setting = await self.services.store.get(
            user_key="", store_key=f"{_BOT_ENABLED_PREFIX}{chat_key}"
        )
        welcome_key = f"chat_welcomed.{channel_key}"
        if (
            bot_setting is None
            and not is_command
            and msg.at_bot
            and not self._default_bot_enabled(source)
            and await self.services.store.get(user_key="", store_key=welcome_key) is None
        ):
            await self.services.store.set(user_key="", store_key=welcome_key, value="1")
            return self._welcome_message(locale)
        if bot_setting == _BOT_DISABLED_VALUE:
            if not self._is_bot_on_command(text, locale):
                return None
        elif bot_setting != _BOT_ENABLED_VALUE and not self._default_bot_enabled(source) and not is_command:
            return None

        if self._requires_mention(source) and not msg.at_bot and not is_command:
            return None

        if not self.rate_limiter.allow(user_key) or not self.rate_limiter.allow(chat_key):
            return ChatMessage(text=get_i18n(locale).t("runner.throttled"))

        adapter = self._adapter_for(source.platform)
        capabilities = getattr(adapter, "capabilities", None)
        manage_typing = bool(getattr(capabilities, "typing", False))
        if manage_typing:
            await adapter._set_typing_safely(source, True)
        # A crashing command / KP turn / tool must degrade to a friendly localized
        # reply, never propagate out of the inbound handler — an unguarded raise here
        # would tear down the adapter's listen loop and permanently disconnect the bot
        # (mirrors the try/except in `net.tui_server.dispatch_input`).
        try:
            if self.hub is None:
                return await self._answer_standalone(ctx, text)
            return await self._answer_on_hub(
                msg,
                source,
                user_key,
                locale,
                text,
                command,
                chat_key,
                keeper_role,
            )
        except Exception:
            logger.exception("runner.turn_failed chat_key=%s", chat_key)
            return ChatMessage(text=get_i18n(locale).t("runner.error"))
        finally:
            if manage_typing:
                await adapter._set_typing_safely(source, False)

    async def _answer_standalone(self, ctx: AgentCtx, text: str) -> ChatMessage | None:
        """Resolve one direct reply for a single-channel adapter such as the CLI."""
        command_reply = await self.command_router.dispatch(ctx, text)
        if command_reply is not None:
            resolved = self.command_router.resolve(text, ctx.locale)
            private = bool(resolved and resolved[0].private_reply)
            return ChatMessage(text=command_reply, markdown=False, private=private)

        toolset = self.toolset or build_kp_toolset(self.services)
        result = await run_kp_turn(
            ctx,
            self.services,
            toolset,
            text,
            output_review=lambda value: self.censor.review(value).cleaned,
        )
        return ChatMessage(text=result.reply, markdown=True)

    async def _answer_on_hub(
        self,
        msg: InboundMessage,
        source: Any,
        user_key: str,
        locale: str,
        text: str,
        command: tuple[CommandSpec, str] | None,
        session_key: str,
        keeper_role: str | None,
    ) -> ChatMessage | None:
        """Shared-hub path (M7): subscribe this channel as a member, run the turn
        through the hub so it fans out to every transport, and keep `.room`
        control replies scoped to the origin channel."""
        adapter = self._adapter_for(source.platform)
        ctx_extra = {"source": source, "raw": msg.raw or {}}
        if msg.interaction is not None and msg.interaction.private:
            ctx_extra["private_interaction"] = True
        if keeper_role is not None:
            ctx_extra["role"] = keeper_role
        hub_ctx = AgentCtx(
            chat_key=session_key,
            user_id=user_key,
            platform=source.platform,
            locale=locale,
            fs=self._fs_for(source.platform),
            extra=ctx_extra,
        )

        if adapter is None:
            # No adapter to deliver through: degrade to the single-reply path.
            return await self._answer_standalone(hub_ctx, text)

        if command is not None and command[0].private_reply and not adapter.supports_private_reply(source):
            return ChatMessage(text=get_i18n(locale).t("runner.private_reply_unavailable"))

        # On the shared-room path the toolset is wired with the hub + router so the KP's
        # `companion_act` tool can drive a live companion turn (M10).
        toolset = self.toolset or build_kp_toolset(self.services, hub=self.hub, command_router=self.command_router)
        # Serialize the WHOLE turn per room (F8): two channels bound to one session (or a
        # terminal member in combined mode) must not interleave read-modify-write of the shared
        # per-room state. Keyed by `session_key` on the shared hub, so it also serializes against
        # a TUI turn on the same room; the companion sub-turn re-enters `run_turn` directly (never
        # this choke point), so it never re-acquires this lock and cannot self-deadlock.
        async with self.hub.turn_lock(session_key):
            keeper_role = await self._keeper_role(source, session_key)
            if keeper_role is None:
                hub_ctx.extra.pop("role", None)
            else:
                hub_ctx.extra["role"] = keeper_role
            member = await self._ensure_member(adapter, source, session_key, locale)
            attachment_fs: AttachmentFs | None = None
            try:
                private_command = bool(
                    hub_ctx.extra.get("private_interaction")
                    or (command is not None and command[0].private_reply)
                )
                may_ingest = bool(
                    command is None
                    or command[0].required_level == 0
                    or keeper_role is not None
                    or source.platform == "cli"
                )
                if msg.attachments and may_ingest:
                    attachment_fs = await self._ingest_attachments(
                        adapter,
                        member,
                        msg,
                        session_key,
                        user_key,
                        publish_events=not private_command,
                    )
                    if attachment_fs is not None:
                        hub_ctx.fs = attachment_fs
                        hub_ctx.extra["attachment_names"] = list(attachment_fs.names)
                    if not text.strip():
                        if attachment_fs is None:
                            return ChatMessage(
                                text=get_i18n(locale).t("runner.attachment_unsupported")
                            )
                        text = get_i18n(locale).t(
                            "runner.attachment_input",
                            names=", ".join(attachment_fs.names),
                        )

                if command is not None and command[0].canonical in {"room", "bind", "unbind"}:
                    reply = await self.command_router.dispatch(hub_ctx, text)
                    new_session = await resolve_session_key(self.services.store, source)
                    if new_session != member.session_key:
                        await self.hub.unsubscribe(member)
                        self._members.pop(source.chat_key(), None)
                    return (
                        ChatMessage(
                            text=reply,
                            private=command[0].canonical in {"bind", "unbind"},
                        )
                        if reply is not None
                        else None
                    )

                await run_turn(
                    self.hub,
                    self.services,
                    hub_ctx,
                    text,
                    command_router=self.command_router,
                    toolset=toolset,
                    censor=self.censor,
                    origin=member,
                    echo_exclude=member,
                )
            finally:
                if attachment_fs is not None:
                    attachment_fs.close()
        return None

    def _adapter_for(self, platform: str) -> BaseAdapter | None:
        return next((adapter for adapter in self.adapters if adapter.platform == platform), None)

    async def _ensure_member(
        self, adapter: BaseAdapter, source: SessionSource, session_key: str, locale: str
    ) -> AdapterMember:
        """Return this channel's `AdapterMember`, subscribing it once and
        resubscribing it if a `.room` rebind moved it to a new session."""
        channel_key = source.chat_key()
        existing = self._members.get(channel_key)
        if existing is not None and existing.session_key == session_key:
            existing.observe(source)
            existing.locale = locale
            if existing not in self.hub.members(session_key):
                await self.hub.subscribe(session_key, existing)
            return existing
        if existing is not None:
            await self.hub.unsubscribe(existing)
        member = AdapterMember(adapter, source, session_key, locale=locale, media_store=self.media_store)
        self._members[channel_key] = member
        await self.hub.subscribe(session_key, member)
        return member

    async def _ingest_attachments(
        self,
        adapter: BaseAdapter,
        member: AdapterMember,
        msg: InboundMessage,
        session_key: str,
        user_key: str,
        *,
        publish_events: bool,
    ) -> AttachmentFs | None:
        stored: list[ChatAttachment] = []
        for attachment in msg.attachments:
            mime = attachment.mime.casefold()
            if mime not in ALLOWED_CHAT_ATTACHMENT_MIMES:
                continue
            limit = (
                self.services.settings.tui.audio_max_file_bytes
                if is_audio_mime(mime)
                else self.services.settings.tui.media_max_file_bytes
            )
            if attachment.size > limit:
                continue
            try:
                data = await adapter.fetch_attachment(attachment, max_bytes=limit)
            except Exception as exc:
                logger.warning(
                    "adapter.attachment_fetch_failed platform=%s error=%s",
                    adapter.platform,
                    type(exc).__name__,
                )
                continue
            if len(data) > limit:
                continue
            if mime not in ALLOWED_IMAGE_MIMES and not is_audio_mime(mime):
                stored.append(
                    ChatAttachment(
                        id=attachment.id,
                        name=attachment.name,
                        mime=mime,
                        size=len(data),
                        data=data,
                    )
                )
                continue
            store = self.audio_store if is_audio_mime(mime) else self.media_store
            record = await store.register_blob(
                room=session_key,
                data=data,
                mime=mime,
                name=attachment.name,
                uploader=user_key,
            )
            stored.append(
                ChatAttachment(
                    id=record.hash,
                    name=record.name,
                    mime=record.mime,
                    size=record.size,
                    data=data,
                )
            )
            if is_audio_mime(record.mime):
                if publish_events:
                    frame = await add_audio_item(
                        self.services.store, session_key, record, member.name
                    )
                    await self.hub.publish(
                        session_key, Event.audio(frame), exclude=member
                    )
            elif record.mime in ALLOWED_IMAGE_MIMES:
                if publish_events:
                    frame = media_frame(record, from_name=member.name)
                    await record_media_history(self.services.store, session_key, frame)
                    await self.hub.publish(
                        session_key, Event.media(frame), exclude=member
                    )
        return AttachmentFs(stored) if stored else None

    async def start(self) -> None:
        for adapter in self.adapters:
            adapter.set_message_handler(self.on_inbound, manages_typing=True)
        try:
            results = await asyncio.gather(
                *(adapter.connect() for adapter in self.adapters),
                return_exceptions=True,
            )
        except asyncio.CancelledError:
            # External cancellation (for example SIGTERM during startup) cancels
            # gather before it can return a CancelledError result. Always unwind
            # adapters that connected or partially initialized, then preserve the
            # caller's cancellation.
            await _disconnect_adapters(self.adapters)
            raise
        cancelled = next(
            (result for result in results if isinstance(result, asyncio.CancelledError)),
            None,
        )
        if cancelled is not None:
            await asyncio.gather(
                *(adapter.disconnect() for adapter in self.adapters),
                return_exceptions=True,
            )
            raise cancelled
        failed: list[BaseAdapter] = []
        for adapter, result in zip(self.adapters, results, strict=True):
            if result is True:
                continue
            failed.append(adapter)
            if isinstance(result, BaseException):
                logger.warning(
                    "adapter.connect_failed platform=%s error=%s",
                    adapter.platform,
                    type(result).__name__,
                )
            else:
                logger.warning("adapter.connect_unavailable platform=%s", adapter.platform)
        if failed:
            await asyncio.gather(
                *(adapter.disconnect() for adapter in failed),
                return_exceptions=True,
            )

    async def stop(self) -> None:
        cleanup = asyncio.create_task(_disconnect_adapters(self.adapters))
        try:
            results = await asyncio.shield(cleanup)
        except asyncio.CancelledError:
            # Shield keeps the actual resource cleanup alive. One cancellation
            # has already been delivered, so awaiting the task here completes it
            # before the same cancellation is propagated to the caller.
            await cleanup
            raise
        cancelled = next(
            (result for result in results if isinstance(result, asyncio.CancelledError)),
            None,
        )
        if cancelled is not None:
            raise cancelled
        for adapter, result in zip(self.adapters, results, strict=True):
            if isinstance(result, BaseException):
                logger.warning(
                    "adapter.disconnect_failed platform=%s error=%s",
                    adapter.platform,
                    type(result).__name__,
                )
    async def _locale_for(self, chat_key: str, *, preferred: str = "") -> str:
        for template in _CHAT_LOCALE_KEYS:
            value = await self.services.store.get(user_key="", store_key=template.format(chat_key=chat_key))
            if value:
                return value
        return preferred if preferred in {"en", "zh"} else self.services.settings.locale

    async def _keeper_role(self, source: SessionSource, session_key: str) -> str | None:
        binding = await get_keeper_binding(
            self.services.store,
            source.platform,
            source.user_id,
        )
        if binding is None or session_key_for_room(binding) != session_key:
            return None
        return "keeper"

    def _default_bot_enabled(self, source: Any) -> bool:
        chat_type = str(getattr(source, "chat_type", "") or "").casefold()
        return source.platform == "cli" or chat_type in _DIRECT_CHAT_TYPES

    def _welcome_message(self, locale: str) -> ChatMessage:
        i18n = get_i18n(locale)
        return ChatMessage(
            text=i18n.t("runner.welcome"),
            markdown=True,
            components=[
                ChatComponent(id="welcome:help", command=".help", label=i18n.t("runner.welcome.help")),
                ChatComponent(id="welcome:create", command=".coc", label=i18n.t("runner.welcome.create")),
                ChatComponent(id="welcome:sheet", command=".sheet", label=i18n.t("runner.welcome.sheet")),
                ChatComponent(id="welcome:panel", command=".panel", label=i18n.t("runner.welcome.panel")),
            ],
        )

    def _requires_mention(self, source: Any) -> bool:
        chat_type = str(getattr(source, "chat_type", "") or "").casefold()
        return source.platform != "cli" and chat_type not in _DIRECT_CHAT_TYPES

    def _fs_for(self, platform: str):
        adapter = next((item for item in self.adapters if item.platform == platform), None)
        return getattr(adapter, "fs", None)

    def _resolve_command(self, text: str, locale: str) -> tuple[CommandSpec, str] | None:
        return self.command_router.resolve(text, locale)

    def _is_bot_on_command(self, text: str, locale: str) -> bool:
        resolved = self._resolve_command(text, locale)
        if resolved is None:
            return False
        spec, args = resolved
        return spec.canonical == "bot" and args.strip().casefold() in {"on", "1", "true", "开启", "啟用"}

    def _normalize_cli_command_text(self, text: str, locale: str, platform: str) -> str:
        if platform != "cli":
            return text
        stripped = text.lstrip()
        if not stripped or stripped.startswith(_COMMAND_PREFIXES):
            return text
        candidate = f".{stripped}"
        if self.command_router.resolve(candidate, locale) is None:
            return text
        leading = text[: len(text) - len(stripped)]
        return f"{leading}.{stripped}"


async def _disconnect_adapters(adapters: list[BaseAdapter]) -> list[Any]:
    return await asyncio.gather(
        *(adapter.disconnect() for adapter in adapters),
        return_exceptions=True,
    )
