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
from gateway.base_adapter import BaseAdapter
from gateway.commands import CommandRouter, CommandSpec
from gateway.events import InboundMessage
from gateway.hub import RoomHub
from gateway.member import AdapterMember
from gateway.ops import Botlist, Censor, RateLimiter, censor_from_settings
from gateway.rooms import resolve_session_key
from gateway.session import SessionSource
from gateway.turn import run_turn
from infra.i18n import get_i18n

logger = logging.getLogger(__name__)

_BOT_ENABLED_PREFIX = "bot_enabled."
_BOT_ENABLED_VALUE = "1"
_BOT_DISABLED_VALUE = "0"
_CHAT_LOCALE_KEYS = ("chat_locale.{chat_key}", "locale.{chat_key}")
_DIRECT_CHAT_TYPES = {"dm", "direct", "private"}
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
        # An injected hub turns every chat channel into a shared-room member
        # (M7); when None, on_inbound keeps the pre-M7 return-a-string behavior
        # so standalone adapter usage/tests are unaffected.
        self.hub = hub
        self.keystore = keystore
        self.command_router = command_router or CommandRouter(services, keystore=keystore, hub=hub)
        self.toolset = toolset
        self.rate_limiter = RateLimiter()
        # Built from `services.settings.censor` (see `infra.config.CensorSettings` /
        # `docs/deploy.md` "Content moderation") unless a caller injects one (tests).
        # With nothing configured this is an explicit no-op, not a fake wordlist.
        self.censor = censor if censor is not None else censor_from_settings(services.settings.censor)
        self.botlist = Botlist()
        # Per-channel AdapterMember registry (keyed by the channel's own
        # chat_key) so repeat messages from a channel reuse one hub member.
        self._members: dict[str, AdapterMember] = {}

    async def on_inbound(self, msg: InboundMessage) -> str | None:
        source = msg.source
        chat_key = source.chat_key()
        user_key = source.user_key()

        if source.is_bot or self.botlist.is_bot(user_key):
            return None

        locale = await self._locale_for(chat_key)
        ctx = AgentCtx(
            chat_key=chat_key,
            user_id=user_key,
            platform=source.platform,
            locale=locale,
            fs=self._fs_for(source.platform),
            extra={"source": source, "raw": msg.raw or {}},
        )

        text = self._normalize_cli_command_text(msg.text, locale, source.platform)
        command = self._resolve_command(text, locale)
        is_command = command is not None

        if not await self._bot_enabled(source):
            if not self._is_bot_on_command(text, locale):
                return None

        if self._requires_mention(source) and not msg.at_bot and not is_command:
            return None

        if not self.rate_limiter.allow(user_key) or not self.rate_limiter.allow(chat_key):
            return get_i18n(locale).t("runner.throttled")

        # A crashing command / KP turn / tool must degrade to a friendly localized
        # reply, never propagate out of the inbound handler — an unguarded raise here
        # would tear down the adapter's listen loop and permanently disconnect the bot
        # (mirrors the try/except in `net.tui_server.dispatch_input`).
        try:
            if self.hub is None:
                return await self._answer_standalone(ctx, text)
            return await self._answer_on_hub(msg, source, user_key, locale, text, command)
        except Exception:
            logger.exception("runner.turn_failed chat_key=%s", chat_key)
            return get_i18n(locale).t("runner.error")

    async def _answer_standalone(self, ctx: AgentCtx, text: str) -> str | None:
        """Pre-M7 path (no hub): resolve one reply string for the origin channel.

        `BaseAdapter.handle_inbound` sends whatever this returns, so the mock
        adapter tests keep passing unchanged.
        """
        command_reply = await self.command_router.dispatch(ctx, text)
        if command_reply is not None:
            return command_reply

        toolset = self.toolset or build_kp_toolset(self.services)
        result = await run_kp_turn(
            ctx,
            self.services,
            toolset,
            text,
            output_review=lambda value: self.censor.review(value).cleaned,
        )
        return result.reply

    async def _answer_on_hub(
        self,
        msg: InboundMessage,
        source: Any,
        user_key: str,
        locale: str,
        text: str,
        command: tuple[CommandSpec, str] | None,
    ) -> str | None:
        """Shared-hub path (M7): subscribe this channel as a member, run the turn
        through the hub so it fans out to every transport, and keep `.room`
        control replies scoped to the origin channel."""
        adapter = self._adapter_for(source.platform)
        session_key = await resolve_session_key(self.services.store, source)
        hub_ctx = AgentCtx(
            chat_key=session_key,
            user_id=user_key,
            platform=source.platform,
            locale=locale,
            fs=self._fs_for(source.platform),
            extra={"source": source, "raw": msg.raw or {}},
        )

        if adapter is None:
            # No adapter to deliver through: degrade to the single-reply path.
            return await self._answer_standalone(hub_ctx, text)

        member = await self._ensure_member(adapter, source, session_key, locale)

        if command is not None and command[0].canonical == "room":
            # `.room ...` is a control command: reply to the origin channel only
            # (returned value is sent by handle_inbound); never publish it, so a
            # minted join key is not broadcast across the room's other members.
            return await self.command_router.dispatch(hub_ctx, text)

        # On the shared-room path the toolset is wired with the hub + router so the KP's
        # `companion_act` tool can drive a live companion turn (M10).
        toolset = self.toolset or build_kp_toolset(self.services, hub=self.hub, command_router=self.command_router)
        # Serialize the WHOLE turn per room (F8): two channels bound to one session (or a
        # terminal member in combined mode) must not interleave read-modify-write of the shared
        # per-room state. Keyed by `session_key` on the shared hub, so it also serializes against
        # a TUI turn on the same room; the companion sub-turn re-enters `run_turn` directly (never
        # this choke point), so it never re-acquires this lock and cannot self-deadlock.
        async with self.hub.turn_lock(session_key):
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
            existing.source = source  # refresh reply_to / acting-player name
            existing.locale = locale
            return existing
        if existing is not None:
            await self.hub.unsubscribe(existing)
        member = AdapterMember(adapter, source, session_key, locale=locale)
        self._members[channel_key] = member
        await self.hub.subscribe(session_key, member)
        return member

    async def start(self) -> None:
        for adapter in self.adapters:
            adapter.set_message_handler(self.on_inbound)
        await asyncio.gather(*(adapter.connect() for adapter in self.adapters))

    async def stop(self) -> None:
        await asyncio.gather(*(adapter.disconnect() for adapter in self.adapters))

    async def _locale_for(self, chat_key: str) -> str:
        for template in _CHAT_LOCALE_KEYS:
            value = await self.services.store.get(user_key="", store_key=template.format(chat_key=chat_key))
            if value:
                return value
        return self.services.settings.locale

    async def _bot_enabled(self, source: Any) -> bool:
        chat_key = source.chat_key()
        value = await self.services.store.get(user_key="", store_key=f"{_BOT_ENABLED_PREFIX}{chat_key}")
        if value == _BOT_ENABLED_VALUE:
            return True
        if value == _BOT_DISABLED_VALUE:
            return False
        return self._default_bot_enabled(source)

    def _default_bot_enabled(self, source: Any) -> bool:
        chat_type = str(getattr(source, "chat_type", "") or "").casefold()
        return source.platform == "cli" or chat_type in _DIRECT_CHAT_TYPES

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
