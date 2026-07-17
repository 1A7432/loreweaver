"""Telegram gateway adapter with native polling, media, and interactions."""

from __future__ import annotations

import asyncio
import inspect
import io
import logging
import mimetypes
import re
from contextlib import suppress
from dataclasses import replace
from typing import Any

from gateway.base_adapter import BaseAdapter, MessageHandler
from gateway.chat import (
    ChatAttachment,
    ChatCapabilities,
    ChatComponent,
    ChatEmbed,
    ChatInteraction,
    ChatMessage,
    split_text,
)
from gateway.events import InboundMessage, SendResult
from gateway.hub import Event
from gateway.registry import PlatformEntry, platform_registry
from gateway.render_chat import render_chat_event
from gateway.session import SessionSource
from infra.i18n import get_i18n
from infra.i18n import t as localize

try:  # MIT-trimmed from hermes-agent Telegram adapter, Copyright 2025 Nous Research.
    import telegram
    from telegram.ext import Application, TypeHandler
except ImportError:  # pragma: no cover - importability without the optional SDK.
    telegram = None  # type: ignore[assignment]
    Application = None  # type: ignore[assignment,misc]
    TypeHandler = None  # type: ignore[assignment,misc]

TELEGRAM_AVAILABLE = telegram is not None and Application is not None and TypeHandler is not None

logger = logging.getLogger(__name__)

_GROUP_CHAT_TYPES = {"group", "supergroup", "channel"}
_MESSAGE_KEYS = ("message", "edited_message", "channel_post", "edited_channel_post")
_ALLOWED_UPDATES = [*_MESSAGE_KEYS, "callback_query"]
_CAPTION_LIMIT = 1024
_TYPING_REFRESH_SECONDS = 4.0
# Honor flood-control waits up to this long; anything larger propagates as a
# send failure rather than stalling a turn indefinitely.
_FLOOD_RETRY_MAX_SECONDS = 30.0
_BOT_COMMAND = re.compile(r"^(?P<command>/[^\s@]+)@(?P<username>[A-Za-z0-9_]+)(?=\s|$)")


class TelegramAdapter(BaseAdapter):
    platform = "telegram"
    capabilities = ChatCapabilities(
        attachments=True,
        typing=True,
        max_text_chars=4096,
    )

    def __init__(
        self,
        config: Any = None,
        transport: Any | None = None,
        command_router: Any | None = None,
        on_message: MessageHandler | None = None,
        *,
        application: Any | None = None,
        locale: str | None = None,
        store: Any | None = None,
    ) -> None:
        super().__init__(config=config, on_message=on_message)
        self.token = str(_config_value(config, "token") or _config_value(config, "bot_token") or "")
        self.locale = locale or _config_value(config, "locale") or None
        self.command_router = command_router
        self._store = store
        self._transport = transport or getattr(application, "bot", None)
        self._application = application
        self._owns_application = application is None
        self._initialized = False
        self._started = False
        self._polling = False
        self._connected = False
        self._bot_id: str | None = None
        self._bot_username: str | None = None
        self._typing_tasks: dict[str, asyncio.Task[None]] = {}
        self._typing_counts: dict[str, int] = {}
        self._typing_lock = asyncio.Lock()
        self._closing = False
        self._panels: dict[str, str] = {}
        self._panel_locks: dict[str, asyncio.Lock] = {}

    async def connect(self) -> bool:
        if self._connected:
            return True
        self._closing = False

        if self._application is None and self._transport is not None:
            if not await self._refresh_identity_safely():
                return False
            self._connected = True
            await self._register_commands_safely()
            return True

        if self._application is None:
            if not TELEGRAM_AVAILABLE or not self.token:
                return False
            self._application = self._build_application()
            self._transport = self._application.bot

        try:
            try:
                await _maybe_await(self._application.initialize())
            except BaseException:
                await self._shutdown_partially_initialized_bot()
                raise
            self._initialized = True
            await _maybe_await(self._application.start())
            self._started = True
            if not await self._refresh_identity_safely():
                # Without getMe the bot cannot recognize @-mentions, so every
                # mention-gated group message would be dropped silently; fail
                # closed like Feishu does on its identity lookup.
                raise RuntimeError("telegram.identity.unavailable")
            await self._register_commands_safely()
            updater = getattr(self._application, "updater", None)
            if updater is None:
                raise RuntimeError("telegram.updater.missing")
            await _maybe_await(updater.start_polling(allowed_updates=_ALLOWED_UPDATES))
            self._polling = True
        except Exception as exc:
            logger.warning("telegram.connect_failed error=%s", type(exc).__name__)
            await self._stop_application()
            if self._owns_application:
                self._application = None
                self._transport = None
            return False

        self._connected = True
        return True

    async def _shutdown_partially_initialized_bot(self) -> None:
        application = self._application
        bot = getattr(application, "bot", None) if application is not None else None
        if bot is None:
            return
        for name in ("shutdown", "aclose", "close"):
            method = getattr(bot, name, None)
            if callable(method):
                try:
                    await _maybe_await(method())
                except Exception as exc:
                    logger.warning(
                        "telegram.partial_initialize_shutdown_failed error=%s",
                        type(exc).__name__,
                    )
                return

    def _build_application(self) -> Any:
        assert Application is not None
        assert TypeHandler is not None
        assert telegram is not None
        application = Application.builder().token(self.token).concurrent_updates(True).build()
        application.add_handler(TypeHandler(telegram.Update, self._handle_sdk_update))
        return application

    async def _handle_sdk_update(self, update: Any, _context: Any) -> None:
        payload = update.to_dict() if hasattr(update, "to_dict") else update
        if isinstance(payload, dict):
            await self.handle_update(payload)

    async def disconnect(self) -> None:
        self._closing = True
        self._connected = False
        if self._application is not None:
            await self._stop_application()
            await self._stop_typing_tasks()
            if self._owns_application:
                self._application = None
                self._transport = None
            return

        await self._stop_typing_tasks()
        transport = self._transport
        if transport is None:
            return
        for name in ("aclose", "close", "shutdown"):
            method = getattr(transport, name, None)
            if method is not None:
                await _maybe_await(method())
                return

    async def _stop_application(self) -> None:
        application = self._application
        if application is None:
            return
        updater = getattr(application, "updater", None)
        updater_running = bool(getattr(updater, "running", False)) if updater is not None else False
        if updater is not None and (self._polling or updater_running):
            try:
                await _maybe_await(updater.stop())
            except Exception as exc:
                logger.warning("telegram.updater_stop_failed error=%s", type(exc).__name__)
            finally:
                self._polling = False
        if self._started:
            try:
                await _maybe_await(application.stop())
            except Exception as exc:
                logger.warning("telegram.application_stop_failed error=%s", type(exc).__name__)
            finally:
                self._started = False
        if self._initialized:
            try:
                await _maybe_await(application.shutdown())
            except Exception as exc:
                logger.warning("telegram.application_shutdown_failed error=%s", type(exc).__name__)
            finally:
                self._initialized = False

    def parse_update(self, update: dict[str, Any]) -> InboundMessage | None:
        callback = update.get("callback_query")
        if isinstance(callback, dict):
            return self._parse_callback_query(update, callback)

        message = _extract_message(update)
        if message is None:
            return None
        return self._parse_message(update, message)

    def _parse_callback_query(
        self,
        update: dict[str, Any],
        callback: dict[str, Any],
    ) -> InboundMessage | None:
        message = callback.get("message")
        command = callback.get("data")
        if not isinstance(message, dict) or not isinstance(command, str) or not command:
            return None
        sender = callback.get("from")
        sender = sender if isinstance(sender, dict) else {}
        source = self._source_from_message(
            message,
            sender=sender,
            user_id=_string_id(sender.get("id")),
        )
        if source is None:
            return None
        interaction_id = _string_id(callback.get("id"))
        if interaction_id is None:
            return None
        return InboundMessage(
            source=source,
            text=command,
            at_bot=True,
            interaction=ChatInteraction(
                id=interaction_id,
                locale=_locale_code(sender.get("language_code")),
            ),
            raw=update,
        )

    def _parse_message(
        self,
        update: dict[str, Any],
        message: dict[str, Any],
    ) -> InboundMessage | None:
        user = message.get("from")
        user = user if isinstance(user, dict) else None
        sender_chat = message.get("sender_chat")
        sender_chat = sender_chat if isinstance(sender_chat, dict) else {}
        # Anonymous administrators and channel posts identify a chat in
        # ``sender_chat``, not a user that can receive a private message.
        # Preserve its display name while keeping the private target absent.
        sender = sender_chat or user or {}
        source = self._source_from_message(
            message,
            sender=sender,
            user_id=(
                _string_id(user.get("id"))
                if user is not None and not sender_chat
                else None
            ),
        )
        if source is None:
            return None

        raw_text = message.get("text")
        entities = message.get("entities")
        if not isinstance(raw_text, str):
            raw_text = message.get("caption")
            entities = message.get("caption_entities")
        text = raw_text if isinstance(raw_text, str) else ""
        entities = entities if isinstance(entities, list) else []
        attachments = _message_attachments(message)
        if not text and not attachments:
            return None

        at_bot = self._mentions_self(text, entities)
        text = self._strip_self_mentions(text, entities).strip()
        text = self._normalize_command(text)
        reply = message.get("reply_to_message")
        return InboundMessage(
            source=source,
            text=text,
            at_bot=at_bot,
            attachments=attachments,
            quoted_text=_message_text(reply) if isinstance(reply, dict) else "",
            raw=update,
        )

    def _source_from_message(
        self,
        message: dict[str, Any],
        *,
        sender: dict[str, Any],
        user_id: str | None,
    ) -> SessionSource | None:
        chat = message.get("chat")
        if not isinstance(chat, dict):
            return None
        chat_id = _string_id(chat.get("id"))
        if chat_id is None:
            return None
        chat_type = str(chat.get("type") or "").casefold()
        return SessionSource(
            platform=self.platform,
            chat_type="group" if chat_type in _GROUP_CHAT_TYPES else "dm",
            chat_id=chat_id,
            user_id=user_id,
            user_name=_user_name(sender),
            thread_id=_string_id(message.get("message_thread_id")),
            message_id=_string_id(message.get("message_id")),
            is_bot=bool(sender.get("is_bot")),
        )

    async def handle_update(self, update: dict[str, Any]) -> InboundMessage | None:
        callback = update.get("callback_query")
        if isinstance(callback, dict) and callback.get("id") is not None:
            await self._answer_callback_safely(str(callback["id"]))
        inbound = self.parse_update(update)
        if inbound is None:
            return None
        await self.handle_inbound(inbound)
        return inbound

    async def _answer_callback_safely(self, callback_id: str) -> None:
        try:
            await self._call_transport(
                "answerCallbackQuery",
                "answer_callback_query",
                callback_query_id=callback_id,
            )
        except Exception as exc:
            logger.warning("telegram.callback_answer_failed error=%s", type(exc).__name__)

    async def fetch_attachment(
        self,
        attachment: ChatAttachment,
        *,
        max_bytes: int | None = None,
    ) -> bytes:
        if attachment.data is not None:
            return await super().fetch_attachment(attachment, max_bytes=max_bytes)
        if max_bytes is not None and attachment.size > max_bytes:
            raise ValueError("telegram.attachment.too_large")
        try:
            file = await self._call_transport(
                "getFile",
                "get_file",
                file_id=attachment.id,
            )
            file_size = _safe_int(_object_value(file, "file_size"))
            if max_bytes is not None and file_size > max_bytes:
                raise ValueError("telegram.attachment.too_large")
            data = await _download_file(file)
            if max_bytes is not None and len(data) > max_bytes:
                raise ValueError("telegram.attachment.too_large")
            return data
        except ValueError:
            raise
        except Exception:
            raise FileNotFoundError(attachment.id or attachment.name) from None

    def supports_private_reply(self, source: SessionSource) -> bool:
        return bool(source.user_id)

    async def send_message(
        self,
        source: SessionSource,
        message: ChatMessage,
        *,
        reply_to: str | None = None,
        session_key: str | None = None,
    ) -> SendResult:
        message = replace(message, text=_render_text(message), embeds=[])
        # Telegram counts its 4096 limit in UTF-16 code units, not code points;
        # pre-split here so the code-point splitter in the base class never
        # produces a chunk the API rejects (non-BMP emoji weigh 2 units each).
        result = SendResult(ok=True)
        for part in _split_message_utf16(message, self.capabilities.max_text_chars):
            result = await super().send_message(
                source,
                part,
                reply_to=reply_to,
                session_key=session_key,
            )
            if not result.ok:
                return result
        return result

    async def _send_message(
        self,
        source: SessionSource,
        message: ChatMessage,
        *,
        reply_to: str | None,
        session_key: str | None,
    ) -> SendResult:
        del session_key
        if message.private and not source.user_id:
            return SendResult(ok=False, error="telegram.private_target.unavailable")
        target = source.user_id if message.private else source.chat_id
        assert target is not None
        effective_reply = reply_to if target == source.chat_id else None
        effective_thread = source.thread_id if target == source.chat_id else None
        text = _render_text(message)
        components = _reply_markup(message.components)
        try:
            if not message.attachments:
                response = await self._send_text(
                    target,
                    effective_thread,
                    text,
                    markdown=message.markdown,
                    reply_to=effective_reply,
                    reply_markup=components,
                )
                return SendResult(ok=True, message_id=_message_id_from_response(response))
            return await self._send_with_attachments(
                target,
                effective_thread,
                message,
                text=text,
                reply_to=effective_reply,
                reply_markup=components,
            )
        except Exception as exc:
            if message.private and target != source.chat_id and _is_forbidden(exc):
                # Telegram forbids DMs to users who never started the bot; tell
                # them in the origin chat instead of failing silently.
                return await self._notify_private_reply_blocked(source, reply_to)
            logger.warning("telegram.send_failed error=%s", type(exc).__name__)
            return SendResult(ok=False, error="telegram.send_failed")

    async def _notify_private_reply_blocked(
        self,
        source: SessionSource,
        reply_to: str | None,
    ) -> SendResult:
        notice = localize("telegram.private_reply_blocked", locale=self.locale)
        try:
            await self._send_text(
                source.chat_id,
                source.thread_id,
                notice,
                markdown=False,
                reply_to=reply_to,
                reply_markup=None,
            )
        except Exception as exc:
            logger.warning("telegram.private_reply_notice_failed error=%s", type(exc).__name__)
        return SendResult(ok=False, error="telegram.private_reply_blocked")

    async def _send_with_attachments(
        self,
        chat_id: str,
        thread_id: str | None,
        message: ChatMessage,
        *,
        text: str,
        reply_to: str | None,
        reply_markup: dict[str, Any] | None,
    ) -> SendResult:
        first_id: str | None = None
        caption = text if len(text) <= _CAPTION_LIMIT else ""
        if text and not caption:
            response = await self._send_text(
                chat_id,
                thread_id,
                text,
                markdown=message.markdown,
                reply_to=reply_to,
                reply_markup=reply_markup,
            )
            first_id = _message_id_from_response(response)
            reply_to = None
            reply_markup = None

        for index, attachment in enumerate(message.attachments):
            response = await self._send_attachment(
                chat_id,
                thread_id,
                attachment,
                caption=caption if index == 0 else "",
                markdown=message.markdown,
                reply_to=reply_to if index == 0 else None,
                reply_markup=reply_markup if index == 0 else None,
            )
            first_id = first_id or _message_id_from_response(response)
        return SendResult(ok=True, message_id=first_id)

    async def _send_text(
        self,
        chat_id: str,
        thread_id: str | None,
        text: str,
        *,
        markdown: bool,
        reply_to: str | None,
        reply_markup: dict[str, Any] | None,
    ) -> Any:
        params = _message_params(
            chat_id,
            thread_id,
            reply_to=reply_to,
            reply_markup=reply_markup,
        )
        params["text"] = text or " "
        return await self._call_with_markdown_fallback(
            "sendMessage",
            "send_message",
            params,
            markdown=markdown,
        )

    async def _send_attachment(
        self,
        chat_id: str,
        thread_id: str | None,
        attachment: ChatAttachment,
        *,
        caption: str,
        markdown: bool,
        reply_to: str | None,
        reply_markup: dict[str, Any] | None,
    ) -> Any:
        bot_name, sdk_name, argument = _attachment_method(attachment)
        value: Any = attachment.data or attachment.url or attachment.id
        if attachment.data is not None:
            value = io.BytesIO(attachment.data)
            value.name = attachment.name
        params = _message_params(
            chat_id,
            thread_id,
            reply_to=reply_to,
            reply_markup=reply_markup,
        )
        params[argument] = value
        if caption:
            params["caption"] = caption
        return await self._call_with_markdown_fallback(
            bot_name,
            sdk_name,
            params,
            markdown=markdown and bool(caption),
        )

    async def _call_with_markdown_fallback(
        self,
        bot_api_name: str,
        sdk_name: str,
        params: dict[str, Any],
        *,
        markdown: bool,
    ) -> Any:
        if not markdown:
            return await self._call_flood_controlled(bot_api_name, sdk_name, params)
        rich = {**params, "parse_mode": "Markdown"}
        try:
            return await self._call_flood_controlled(bot_api_name, sdk_name, rich)
        except Exception as exc:
            if _is_message_not_modified(exc) or not _is_bad_request(exc):
                raise
            return await self._call_flood_controlled(bot_api_name, sdk_name, params)

    async def _call_flood_controlled(
        self,
        bot_api_name: str,
        sdk_name: str,
        params: dict[str, Any],
    ) -> Any:
        """Honor one flood-control (RetryAfter/429) wait instead of dropping the send."""
        try:
            return await self._call_transport(bot_api_name, sdk_name, **params)
        except Exception as exc:
            delay = _retry_after_seconds(exc)
            if delay is None or delay > _FLOOD_RETRY_MAX_SECONDS:
                raise
            logger.warning("telegram.flood_control retry_after=%.1f", delay)
            await asyncio.sleep(delay)
            return await self._call_transport(bot_api_name, sdk_name, **params)

    async def edit_message(
        self,
        source: SessionSource,
        message_id: str,
        message: ChatMessage,
    ) -> SendResult:
        if message.private and not source.user_id:
            return SendResult(ok=False, error="telegram.private_target.unavailable")
        target = source.user_id if message.private else source.chat_id
        rendered = _render_text(message) or " "
        if len(rendered) > self.capabilities.max_text_chars:
            return SendResult(ok=False, error="telegram.edit_too_long")
        params: dict[str, Any] = {
            "chat_id": target,
            "message_id": _numeric_id(message_id),
            "text": rendered,
        }
        reply_markup = _reply_markup(message.components)
        if reply_markup is not None:
            params["reply_markup"] = reply_markup
        try:
            response = await self._call_with_markdown_fallback(
                "editMessageText",
                "edit_message_text",
                params,
                markdown=message.markdown,
            )
        except Exception as exc:
            if _is_message_not_modified(exc):
                return SendResult(ok=True, message_id=message_id)
            logger.warning("telegram.edit_failed error=%s", type(exc).__name__)
            return SendResult(ok=False, error="telegram.edit_failed")
        return SendResult(
            ok=True,
            message_id=_message_id_from_response(response) or message_id,
        )

    async def deliver_event(
        self,
        source: SessionSource,
        session_key: str,
        event: Event,
        *,
        locale: str,
        media_store: Any = None,
    ) -> SendResult | None:
        if event.kind not in {"panel", "state"}:
            return await super().deliver_event(
                source,
                session_key,
                event,
                locale=locale,
                media_store=media_store,
            )

        key = source.chat_key()
        lock = self._panel_locks.setdefault(key, asyncio.Lock())
        async with lock:
            panel_id = await self._panel_id(source)
            message = self._panel_message(source, event, locale)
            if event.kind == "state" and panel_id is None:
                return None

            if panel_id is not None:
                result = await self.edit_message(source, panel_id, message)
                if result.ok:
                    return result
                if event.kind == "state" and len(
                    _render_text(message)
                ) > self.capabilities.max_text_chars:
                    # Re-creating would not be re-rememberable, and state fires
                    # every turn — bail out rather than re-post a panel per turn.
                    return result

            result = await self.send_message(source, message, session_key=session_key)
            # A split panel cannot be updated atomically, so remember only a
            # single-message representation. Normal room snapshots fit this limit.
            if (
                result.ok
                and result.message_id
                and len(_render_text(message)) <= self.capabilities.max_text_chars
            ):
                await self._remember_panel(source, result.message_id)
            return result

    def _panel_message(self, source: SessionSource, event: Event, locale: str) -> ChatMessage:
        data = dict(event.data)
        if source.chat_type.casefold() not in {"dm", "direct", "private", "c2c"}:
            data.pop("character", None)
        panel = render_chat_event(
            Event.panel(data, private=event.private),
            get_i18n(locale),
        )
        assert panel is not None
        panel.components = [
            ChatComponent(
                id="lw:panel",
                command=".panel",
                label=get_i18n(locale).t("rooms.chat.panel.title"),
                style="primary",
            ),
            ChatComponent(
                id="lw:sheet",
                command=".sheet",
                label=get_i18n(locale).t("commands.help.sheet"),
            ),
            ChatComponent(id="lw:roll", command=".roll 1d20", label="d20"),
        ]
        return panel

    async def _panel_id(self, source: SessionSource) -> str | None:
        key = source.chat_key()
        panel_id = self._panels.get(key)
        if panel_id is not None or self._store is None:
            return panel_id
        try:
            panel_id = await self._store.get(
                user_key="",
                store_key=f"telegram.panel.{key}",
            )
        except Exception as exc:
            logger.warning("telegram.panel_load_failed error=%s", type(exc).__name__)
            return None
        if panel_id:
            self._panels[key] = panel_id
        return panel_id

    async def _remember_panel(self, source: SessionSource, message_id: str) -> None:
        key = source.chat_key()
        self._panels[key] = message_id
        if self._store is None:
            return
        try:
            await self._store.set(
                user_key="",
                store_key=f"telegram.panel.{key}",
                value=message_id,
            )
        except Exception as exc:
            logger.warning("telegram.panel_store_failed error=%s", type(exc).__name__)

    async def set_typing(self, source: SessionSource, active: bool) -> None:
        key = source.chat_key()
        task_to_stop: asyncio.Task[None] | None = None
        should_start = False
        async with self._typing_lock:
            count = self._typing_counts.get(key, 0)
            if active:
                if self._closing:
                    return
                self._typing_counts[key] = count + 1
                should_start = count == 0
            elif count > 1:
                self._typing_counts[key] = count - 1
            else:
                self._typing_counts.pop(key, None)
                task_to_stop = self._typing_tasks.pop(key, None)

        if task_to_stop is not None:
            task_to_stop.cancel()
            with suppress(asyncio.CancelledError):
                await task_to_stop
        if not should_start:
            return
        try:
            await self._send_typing(source)
        except BaseException:
            async with self._typing_lock:
                self._typing_counts.pop(key, None)
            raise
        async with self._typing_lock:
            if self._closing or not self._typing_counts.get(key):
                return
            self._typing_tasks[key] = asyncio.create_task(self._typing_loop(source))

    async def _typing_loop(self, source: SessionSource) -> None:
        while True:
            await asyncio.sleep(_TYPING_REFRESH_SECONDS)
            try:
                await self._send_typing(source)
            except Exception as exc:
                logger.warning("telegram.typing_refresh_failed error=%s", type(exc).__name__)
                return

    async def _send_typing(self, source: SessionSource) -> None:
        params: dict[str, Any] = {"chat_id": source.chat_id, "action": "typing"}
        if source.thread_id:
            params["message_thread_id"] = _numeric_id(source.thread_id)
        await self._call_transport("sendChatAction", "send_chat_action", **params)

    async def _stop_typing_tasks(self) -> None:
        async with self._typing_lock:
            tasks = list(self._typing_tasks.values())
            self._typing_tasks.clear()
            self._typing_counts.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def register_commands(self, locale: str = "en") -> list[dict[str, str]]:
        definitions = [] if self.command_router is None else self.command_router.slash_definitions(locale)
        payload = [
            {
                "command": str(item["name"]).casefold(),
                "description": str(item["description"])[:256],
            }
            for item in definitions
            if item.get("name") and item.get("description")
        ]
        await self._call_set_commands(payload)
        return payload

    async def _register_commands_safely(self) -> None:
        if self.command_router is None:
            return
        try:
            await self.register_commands(self.locale or "en")
        except Exception as exc:
            logger.warning("telegram.command_registration_failed error=%s", type(exc).__name__)

    async def _refresh_identity_safely(self) -> bool:
        """Resolve the bot's own id/username; False means getMe raised.

        A transport without getMe (minimal test double) is not a failure —
        there is simply no identity to resolve.
        """
        method = self._transport_method("getMe", "get_me")
        if method is None:
            return True
        try:
            value = await _maybe_await(method())
        except Exception as exc:
            logger.warning("telegram.identity_failed error=%s", type(exc).__name__)
            return False
        self._bot_id = _string_id(_object_value(value, "id"))
        username = _object_value(value, "username")
        self._bot_username = str(username).lstrip("@").casefold() if username else None
        return True

    def _mentions_self(self, text: str, entities: list[Any]) -> bool:
        for entity in entities:
            if not isinstance(entity, dict):
                continue
            kind = str(entity.get("type") or "")
            if kind == "text_mention":
                user = entity.get("user")
                if isinstance(user, dict) and self._bot_id == _string_id(user.get("id")):
                    return True
            if kind not in {"mention", "bot_command"}:
                continue
            token = _entity_text(text, entity)
            if self._bot_username and token.casefold().endswith(f"@{self._bot_username}"):
                return True
        return False

    def _normalize_command(self, text: str) -> str:
        match = _BOT_COMMAND.match(text)
        if match is None or not self._bot_username:
            return text
        if match.group("username").casefold() != self._bot_username:
            return text
        return f"{match.group('command')}{text[match.end():]}"

    def _strip_self_mentions(self, text: str, entities: list[Any]) -> str:
        ranges: list[tuple[int, int]] = []
        for entity in entities:
            if not isinstance(entity, dict):
                continue
            kind = str(entity.get("type") or "")
            token = _entity_text(text, entity)
            is_self = kind == "mention" and bool(
                self._bot_username and token.casefold() == f"@{self._bot_username}"
            )
            user = entity.get("user")
            is_self = is_self or bool(
                kind == "text_mention"
                and isinstance(user, dict)
                and self._bot_id == _string_id(user.get("id"))
            )
            if is_self:
                byte_range = _entity_byte_range(text, entity)
                if byte_range is not None:
                    start, end = byte_range
                    encoded = text.encode("utf-16-le")
                    space = " ".encode("utf-16-le")
                    if encoded[end : end + 2] == space:
                        end += 2
                    elif encoded[start - 2 : start] == space:
                        start -= 2
                    ranges.append((start, end))
        encoded = text.encode("utf-16-le")
        for start, end in sorted(ranges, reverse=True):
            encoded = encoded[:start] + encoded[end:]
        return encoded.decode("utf-16-le")

    async def _call_transport(self, bot_api_name: str, sdk_name: str, **kwargs: Any) -> Any:
        method = self._transport_method(bot_api_name, sdk_name)
        if method is None:
            raise RuntimeError(localize("telegram.error.missing_transport", locale=self.locale))
        return await _maybe_await(method(**kwargs))

    def _transport_method(self, bot_api_name: str, sdk_name: str) -> Any | None:
        if self._transport is None:
            return None
        return getattr(self._transport, bot_api_name, None) or getattr(self._transport, sdk_name, None)

    async def _call_set_commands(self, payload: list[dict[str, str]]) -> Any:
        method = self._transport_method("setMyCommands", "set_my_commands")
        if method is None:
            raise RuntimeError(localize("telegram.error.missing_transport", locale=self.locale))
        commands = [(item["command"], item["description"]) for item in payload]
        if _accepts_keyword(method, "commands"):
            return await _maybe_await(method(commands=commands))
        return await _maybe_await(method(commands))


def register() -> None:
    platform_registry.register(
        PlatformEntry(
            name="telegram",
            label="Telegram",
            adapter_factory=lambda cfg, context: TelegramAdapter(
                cfg,
                command_router=context.command_router,
                locale=context.services.settings.locale,
                store=getattr(context.services, "store", None),
            ),
            check_fn=lambda: TELEGRAM_AVAILABLE,
            required_env=["TRPG_TELEGRAM__TOKEN"],
            install_hint="uv sync --extra telegram",
        )
    )


def _extract_message(update: dict[str, Any]) -> dict[str, Any] | None:
    for key in _MESSAGE_KEYS:
        message = update.get(key)
        if isinstance(message, dict):
            return message
    return None


def _message_text(message: dict[str, Any]) -> str:
    value = message.get("text")
    if not isinstance(value, str):
        value = message.get("caption")
    return value if isinstance(value, str) else ""


def _message_attachments(message: dict[str, Any]) -> list[ChatAttachment]:
    values: list[tuple[str, dict[str, Any]]] = []
    photos = message.get("photo")
    if isinstance(photos, list):
        candidates = [item for item in photos if isinstance(item, dict)]
        if candidates:
            values.append(("photo", max(candidates, key=_photo_rank)))
    for kind in ("document", "audio", "voice", "video", "animation", "video_note", "sticker"):
        value = message.get(kind)
        if isinstance(value, dict):
            values.append((kind, value))
    return [_attachment_from(kind, value) for kind, value in values if value.get("file_id")]


def _attachment_from(kind: str, value: dict[str, Any]) -> ChatAttachment:
    file_id = str(value.get("file_id") or "")
    mime = str(value.get("mime_type") or _default_mime(kind))
    name = str(value.get("file_name") or _default_name(kind, file_id, mime))
    return ChatAttachment(
        id=file_id,
        name=name,
        mime=mime,
        size=_safe_int(value.get("file_size")),
    )


def _default_mime(kind: str) -> str:
    return {
        "photo": "image/jpeg",
        "voice": "audio/ogg",
        "video": "video/mp4",
        "animation": "video/mp4",
        "video_note": "video/mp4",
        "sticker": "image/webp",
    }.get(kind, "application/octet-stream")


def _default_name(kind: str, file_id: str, mime: str) -> str:
    extension = mimetypes.guess_extension(mime) or ""
    return f"{kind}-{file_id[:12]}{extension}"


def _attachment_method(attachment: ChatAttachment) -> tuple[str, str, str]:
    mime = attachment.mime.casefold()
    if mime in {"image/jpeg", "image/png"}:
        return "sendPhoto", "send_photo", "photo"
    if mime in {"audio/ogg", "audio/opus"}:
        return "sendVoice", "send_voice", "voice"
    if mime in {"audio/aac", "audio/mp4", "audio/mpeg", "audio/x-m4a"}:
        return "sendAudio", "send_audio", "audio"
    if mime == "video/mp4":
        return "sendVideo", "send_video", "video"
    return "sendDocument", "send_document", "document"


def _render_text(message: ChatMessage) -> str:
    lines = [message.text] if message.text else []
    lines.extend(_render_embed(embed) for embed in message.embeds)
    if message.components and not message.text and not message.embeds:
        lines.append(" ")
    return "\n\n".join(line for line in lines if line)


def _render_embed(embed: ChatEmbed) -> str:
    lines = [embed.title, embed.description]
    lines.extend(f"{field.name}: {field.value}" for field in embed.fields)
    lines.append(embed.footer)
    return "\n".join(line for line in lines if line)


def _reply_markup(components: list[ChatComponent]) -> dict[str, Any] | None:
    buttons = [
        {
            "text": component.label or component.id,
            "callback_data": component.command,
        }
        for component in components
        if component.command and len(component.command.encode("utf-8")) <= 64
    ]
    if not buttons:
        return None
    return {
        "inline_keyboard": [buttons[index : index + 2] for index in range(0, len(buttons), 2)]
    }


def _message_params(
    chat_id: str,
    thread_id: str | None,
    *,
    reply_to: str | None,
    reply_markup: dict[str, Any] | None,
) -> dict[str, Any]:
    params: dict[str, Any] = {"chat_id": chat_id}
    if thread_id:
        params["message_thread_id"] = _numeric_id(thread_id)
    if reply_to is not None:
        params["reply_parameters"] = {"message_id": _numeric_id(reply_to)}
    if reply_markup is not None:
        params["reply_markup"] = reply_markup
    return params


async def _download_file(value: Any) -> bytes:
    if isinstance(value, (bytes, bytearray)):
        return bytes(value)
    if isinstance(value, dict):
        data = value.get("data")
        if isinstance(data, (bytes, bytearray)):
            return bytes(data)
    method = getattr(value, "download_as_bytearray", None)
    if method is not None:
        return bytes(await _maybe_await(method()))
    method = getattr(value, "download_to_memory", None)
    if method is not None:
        buffer = io.BytesIO()
        await _maybe_await(method(out=buffer))
        return buffer.getvalue()
    raise FileNotFoundError(_object_value(value, "file_id") or "telegram.file")


def _config_value(config: Any, key: str) -> Any:
    if isinstance(config, dict):
        return config.get(key)
    return getattr(config, key, None)


def _object_value(value: Any, key: str) -> Any:
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _string_id(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)


def _safe_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _photo_rank(value: dict[str, Any]) -> tuple[int, int]:
    return (
        _safe_int(value.get("width")) * _safe_int(value.get("height")),
        _safe_int(value.get("file_size")),
    )


def _numeric_id(value: str) -> int | str:
    try:
        return int(value)
    except ValueError:
        return value


def _user_name(sender: dict[str, Any]) -> str | None:
    username = sender.get("username")
    if isinstance(username, str) and username:
        return username
    title = sender.get("title")
    if isinstance(title, str) and title:
        return title
    names = [
        item
        for item in (sender.get("first_name"), sender.get("last_name"))
        if isinstance(item, str) and item
    ]
    return " ".join(names) or None


def _locale_code(value: Any) -> str:
    code = str(value or "").casefold().replace("_", "-").split("-", 1)[0]
    return code if code in {"en", "zh"} else ""


def _message_id_from_response(response: Any) -> str | None:
    value = _object_value(response, "message_id")
    return None if value is None else str(value)


def _entity_byte_range(text: str, entity: dict[str, Any]) -> tuple[int, int] | None:
    try:
        offset = int(entity.get("offset"))
        length = int(entity.get("length"))
    except (TypeError, ValueError):
        return None
    encoded = text.encode("utf-16-le")
    start = max(offset, 0) * 2
    end = max(offset + length, 0) * 2
    if start > len(encoded) or end > len(encoded) or end < start:
        return None
    return start, end


def _entity_text(text: str, entity: dict[str, Any]) -> str:
    byte_range = _entity_byte_range(text, entity)
    if byte_range is None:
        return ""
    start, end = byte_range
    return text.encode("utf-16-le")[start:end].decode("utf-16-le")


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def _is_bad_request(exc: Exception) -> bool:
    return (
        type(exc).__name__ == "BadRequest"
        or getattr(exc, "status", None) == 400
        or getattr(exc, "status_code", None) == 400
    )


def _is_message_not_modified(exc: Exception) -> bool:
    # i18n-exempt: Telegram Bot API error discriminator, never shown to users.
    return "message is not modified" in str(exc).casefold()


def _retry_after_seconds(exc: Exception) -> float | None:
    """Seconds Telegram asked us to wait, or None when exc is not flood control."""
    if type(exc).__name__ != "RetryAfter" and getattr(exc, "status", None) != 429:
        return None
    delay = getattr(exc, "retry_after", None)
    try:
        return max(float(delay), 0.0) if delay is not None else None
    except (TypeError, ValueError):
        return None


def _is_forbidden(exc: Exception) -> bool:
    return (
        type(exc).__name__ == "Forbidden"
        or getattr(exc, "status", None) == 403
        or getattr(exc, "status_code", None) == 403
    )


def _utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def _split_message_utf16(message: ChatMessage, limit: int) -> list[ChatMessage]:
    """Split so every part fits Telegram's UTF-16-unit budget.

    Mirrors split_chat_message's contract: rich content rides on the last part.
    The common all-BMP case returns the message untouched.
    """
    if _utf16_len(message.text) <= limit:
        return [message]
    chunks: list[str] = []
    for chunk in split_text(message.text, limit):
        chunks.extend(_shrink_to_utf16_limit(chunk, limit))
    last = len(chunks) - 1
    return [
        replace(
            message,
            text=chunk,
            attachments=list(message.attachments) if index == last else [],
            components=list(message.components) if index == last else [],
        )
        for index, chunk in enumerate(chunks)
    ]


def _shrink_to_utf16_limit(chunk: str, limit: int) -> list[str]:
    if _utf16_len(chunk) <= limit:
        return [chunk]
    parts: list[str] = []
    remaining = chunk
    while _utf16_len(remaining) > limit:
        units = 0
        cut = 0
        for index, char in enumerate(remaining):
            width = 2 if ord(char) > 0xFFFF else 1
            if units + width > limit:
                break
            units += width
            cut = index + 1
        window = remaining[:cut]
        floor = max(1, cut // 2)
        boundary = max(window.rfind("\n", floor, cut), window.rfind(" ", floor, cut))
        if boundary >= floor:
            cut = boundary + 1
        parts.append(remaining[:cut])
        remaining = remaining[cut:]
    if remaining:
        parts.append(remaining)
    return parts


def _accepts_keyword(method: Any, name: str) -> bool:
    try:
        parameters = inspect.signature(method).parameters.values()
    except (TypeError, ValueError):
        return True
    return any(
        parameter.kind is inspect.Parameter.VAR_KEYWORD
        or (
            parameter.name == name
            and parameter.kind is not inspect.Parameter.POSITIONAL_ONLY
        )
        for parameter in parameters
    )


register()
