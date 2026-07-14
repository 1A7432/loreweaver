"""Official QQ Bot adapter with passive-window delivery and rich-media fallback."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import mimetypes
import re
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, replace
from typing import Any

import aiohttp

from adapters.qq_official.gateway import QQGateway
from gateway.base_adapter import BaseAdapter, MessageHandler
from gateway.chat import (
    ChatAttachment,
    ChatCapabilities,
    ChatComponent,
    ChatMessage,
    split_chat_message,
)
from gateway.events import InboundMessage, SendResult
from gateway.registry import AdapterContext, PlatformEntry, platform_registry
from gateway.rooms import resolve_session_key
from gateway.session import SessionSource
from infra.config import QQSettings
from infra.i18n import get_i18n
from infra.media_store import ALLOWED_CHAT_ATTACHMENT_MIMES, MediaStore
from infra.store import Store

logger = logging.getLogger(__name__)

API_BASE = "https://api.sgroup.qq.com"
TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"
GATEWAY_URL_PATH = "/gateway"
GROUP_AT_MESSAGE_CREATE = "GROUP_AT_MESSAGE_CREATE"
GROUP_MESSAGE_CREATE = "GROUP_MESSAGE_CREATE"
C2C_MESSAGE_CREATE = "C2C_MESSAGE_CREATE"
INTENTS = (1 << 25) | (1 << 12)

MSG_TYPE_TEXT = 0
MSG_TYPE_MARKDOWN = 2
MSG_TYPE_MEDIA = 7
FILE_IMAGE = 1
FILE_VIDEO = 2
FILE_AUDIO = 3
FILE_GENERIC = 4
MAX_TEXT_CHARS = 1800
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
OUTBOX_MAX_ITEMS = 64
_AT_PREFIX_RE = re.compile(r"^(?:<@!?[^>]+>|@\S+)\s*")


class QQAPIError(RuntimeError):
    def __init__(self, status: int, code: str = "") -> None:
        super().__init__(f"qq.api.{status}.{code}" if code else f"qq.api.{status}")
        self.status = status
        self.code = code


class _DefaultQQTransport:
    def __init__(self, *, app_id: str, secret: str) -> None:
        self._app_id = app_id
        self._secret = secret
        self._access_token = ""
        self._token_expires_at = 0.0
        self._session: aiohttp.ClientSession | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None

    async def token(self) -> str:
        if self._access_token and time.time() < self._token_expires_at - 60:
            return self._access_token
        if not self._app_id or not self._secret:
            raise RuntimeError("qq.credentials.missing")
        session = await self._client()
        async with session.post(
            TOKEN_URL,
            json={"appId": self._app_id, "clientSecret": self._secret},
        ) as response:
            data = await _response_json(response)
            if response.status >= 400:
                raise _api_error(response.status, data)
        token = str(data.get("access_token") or "")
        if not token:
            raise RuntimeError("qq.token.missing")
        self._access_token = token
        self._token_expires_at = time.time() + int(data.get("expires_in") or 7200)
        return token

    async def ws(self, on_payload: Any) -> None:
        gateway = await self.send("GET", GATEWAY_URL_PATH, None)
        url = str(gateway.get("url") or "")
        if not url:
            raise RuntimeError("qq.gateway.missing_url")
        session = await self._client()
        async with session.ws_connect(url) as ws:
            self._ws = ws
            try:
                async for message in ws:
                    if message.type == aiohttp.WSMsgType.TEXT:
                        payload = _parse_json(message.data)
                        if payload is not None:
                            await on_payload(payload)
                    elif message.type in {aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR}:
                        break
            finally:
                if self._ws is ws:
                    self._ws = None

    async def send_ws(self, payload: dict[str, Any]) -> None:
        if self._ws is None or self._ws.closed:
            raise RuntimeError("qq.gateway.not_connected")
        await self._ws.send_json(payload)

    async def close_ws(self) -> None:
        if self._ws is not None and not self._ws.closed:
            await self._ws.close()

    async def send(self, method: str, path: str, body: dict[str, Any] | None) -> dict[str, Any]:
        try:
            return await self._send(method, path, body)
        except QQAPIError as exc:
            if exc.status != 401:
                raise
            self._access_token = ""
            self._token_expires_at = 0.0
            return await self._send(method, path, body)

    async def _send(self, method: str, path: str, body: dict[str, Any] | None) -> dict[str, Any]:
        token = await self.token()
        session = await self._client()
        async with session.request(
            method,
            f"{API_BASE}{path}",
            json=body,
            headers={"Authorization": f"QQBot {token}"},
        ) as response:
            data = await _response_json(response)
            if response.status >= 400:
                raise _api_error(response.status, data)
            return data

    async def fetch(self, url: str) -> bytes:
        session = await self._client()
        async with session.get(url) as response:
            if response.status >= 400:
                raise QQAPIError(response.status)
            return await response.read()

    async def close(self) -> None:
        await self.close_ws()
        if self._session is not None:
            await self._session.close()
            self._session = None

    async def _client(self) -> aiohttp.ClientSession:
        if self._session is None:
            self._session = aiohttp.ClientSession(
                trust_env=True,
                timeout=aiohttp.ClientTimeout(total=30),
            )
        return self._session


@dataclass
class _ReplyWindow:
    message_id: str
    next_sequence: int = 1
    remaining: int = 4
    error: str | None = None
    current_turn: bool = False


class _RecentIds:
    def __init__(self, maximum: int = 4096) -> None:
        self.maximum = maximum
        self.ids: OrderedDict[str, None] = OrderedDict()

    def add(self, value: str) -> bool:
        if value in self.ids:
            self.ids.move_to_end(value)
            return False
        self.ids[value] = None
        if len(self.ids) > self.maximum:
            self.ids.popitem(last=False)
        return True


class QQOfficialAdapter(BaseAdapter):
    platform = "qq"

    def __init__(
        self,
        config: QQSettings,
        *,
        transport: Any | None = None,
        store: Store | None = None,
        media_store: MediaStore | None = None,
        locale: str = "en",
        on_message: MessageHandler | None = None,
        gateway: QQGateway | None = None,
        gateway_sleep: Any = asyncio.sleep,
    ) -> None:
        super().__init__(config=config, on_message=on_message)
        self._app_id = config.app_id
        self._secret = config.secret
        self._markdown_template_id = config.markdown_template_id
        self._keyboard_enabled = config.keyboard_enabled
        self._keyboard_id = config.keyboard_id
        self._store = store
        if self._store is None:
            raise ValueError("qq.store.required")
        self._media_store = media_store
        self._i18n = get_i18n(locale)
        self._transport = transport or _DefaultQQTransport(app_id=self._app_id, secret=self._secret)
        self._gateway = gateway or QQGateway(
            self._transport,
            self._on_dispatch,
            intents=INTENTS,
            sleep=gateway_sleep,
        )
        self.capabilities = ChatCapabilities(
            attachments=True,
            max_text_chars=MAX_TEXT_CHARS,
        )
        self._seen_ids = _RecentIds()
        self._reply_windows: dict[str, _ReplyWindow] = {}
        self._outbox_locks: dict[str, asyncio.Lock] = {}

    @property
    def gateway(self) -> QQGateway:
        return self._gateway

    async def connect(self) -> bool:
        await self._gateway.start()
        return True

    async def disconnect(self) -> None:
        await self._gateway.stop()

    async def dispatch_payload(self, payload: dict[str, Any]) -> None:
        await self._gateway.dispatch_payload(payload)

    async def fetch_attachment(self, attachment: ChatAttachment) -> bytes:
        if attachment.data is not None:
            return attachment.data
        if not attachment.url:
            raise FileNotFoundError(attachment.id or attachment.name)
        return await self._transport.fetch(attachment.url)

    async def send_message(
        self,
        source: SessionSource,
        message: ChatMessage,
        *,
        reply_to: str | None = None,
        session_key: str | None = None,
    ) -> SendResult:
        if message.private and source.chat_type.casefold() != "dm":
            return SendResult(ok=False, error="qq.private.c2c_required")
        if any(
            attachment.size > MAX_ATTACHMENT_BYTES
            or (attachment.data is not None and len(attachment.data) > MAX_ATTACHMENT_BYTES)
            for attachment in message.attachments
        ):
            return SendResult(ok=False, error="qq.media.too_large")
        keyboard = bool(
            message.markdown
            and self._markdown_template_id
            and self._keyboard_enabled
            and message.components
            and not message.attachments
        )
        message = replace(
            message,
            text=_render_text(message, include_components=not keyboard),
            embeds=[],
            components=list(message.components) if keyboard else [],
        )
        messages: list[ChatMessage] = []
        for part in split_chat_message(message, self.capabilities.max_text_chars):
            messages.extend(_atomic_messages(part))
        result = SendResult(ok=True)
        for part in messages:
            result = await self._send_message(source, part, reply_to=reply_to, session_key=session_key)
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
        del reply_to
        room = session_key or await resolve_session_key(self._store, source)
        key = self._outbox_key(source, room)
        item_id = uuid.uuid4().hex
        async with self._outbox_locks.setdefault(key, asyncio.Lock()):
            items = await self._load_outbox(key)
            window = self._reply_windows.get(source.chat_key())
            if (
                not items
                and window is not None
                and window.current_turn
                and window.error is None
                and window.remaining > 0
            ):
                result = await self._send_now(source, room, message, window)
                if result.ok:
                    return result
                window.error = result.error or "qq.send_failed"

            queued_message = await self._persist_attachments(source, room, message)
            if queued_message is None:
                return SendResult(ok=False, error="qq.media_store.required")
            item = {"id": item_id, "message": _message_to_dict(queued_message)}
            items = self._append_bounded(items, item)
            await self._save_outbox(key, items)
            sent = await self._drain_unlocked(source, room, key)
        if item_id in sent:
            return SendResult(ok=True, message_id=sent[item_id])
        if window is not None and window.error is not None:
            return SendResult(ok=False, error=window.error)
        return SendResult(ok=True)

    async def _persist_attachments(
        self,
        source: SessionSource,
        room: str,
        message: ChatMessage,
    ) -> ChatMessage | None:
        attachments: list[ChatAttachment] = []
        for attachment in message.attachments:
            if attachment.data is None:
                attachments.append(attachment)
                continue
            if self._media_store is None:
                return None
            record = await self._media_store.register_blob(
                room=room,
                data=attachment.data,
                mime=attachment.mime,
                name=attachment.name,
                uploader=source.user_key(),
            )
            attachments.append(
                ChatAttachment(
                    id=record.hash,
                    name=record.name,
                    mime=record.mime,
                    size=record.size,
                )
            )
        return replace(message, attachments=attachments)

    async def outbox_size(self, source: SessionSource, session_key: str) -> int:
        return len(await self._load_outbox(self._outbox_key(source, session_key)))

    async def _on_dispatch(self, payload: dict[str, Any]) -> None:
        event_type = str(payload.get("t") or "")
        data = payload.get("d")
        if event_type in {GROUP_AT_MESSAGE_CREATE, GROUP_MESSAGE_CREATE, C2C_MESSAGE_CREATE}:
            await self._on_message(event_type, data)

    async def _on_message(self, event_type: str, data: Any) -> None:
        if not isinstance(data, dict):
            return
        message_id = str(data.get("id") or "")
        if not message_id or not self._seen_ids.add(message_id):
            return
        inbound = self._build_inbound(event_type, data, message_id)
        if inbound is None:
            return
        await self._handle_inbound_window(inbound, message_id)

    async def _handle_inbound_window(self, inbound: InboundMessage, message_id: str) -> None:
        destination = inbound.source.chat_key()
        window = _ReplyWindow(message_id)
        self._reply_windows[destination] = window
        try:
            room = await resolve_session_key(self._store, inbound.source)
            key = self._outbox_key(inbound.source, room)
            async with self._outbox_locks.setdefault(key, asyncio.Lock()):
                await self._drain_unlocked(inbound.source, room, key, max_items=3)
            window.current_turn = True
            await self.handle_inbound(inbound)
        finally:
            if self._reply_windows.get(destination) is window:
                self._reply_windows.pop(destination, None)

    def _build_inbound(
        self,
        event_type: str,
        data: dict[str, Any],
        message_id: str,
    ) -> InboundMessage | None:
        author = data.get("author") if isinstance(data.get("author"), dict) else {}
        if event_type == C2C_MESSAGE_CREATE:
            chat_id = str(author.get("user_openid") or data.get("user_openid") or data.get("openid") or "")
            chat_type = "dm"
            at_bot = False
        else:
            chat_id = str(data.get("group_openid") or data.get("group_id") or "")
            chat_type = "group"
            at_bot = event_type == GROUP_AT_MESSAGE_CREATE
        if not chat_id:
            return None
        user_id = str(
            author.get("member_openid")
            or author.get("user_openid")
            or data.get("member_openid")
            or author.get("id")
            or ""
        )
        text = str(data.get("content") or "").strip()
        if at_bot:
            text = _AT_PREFIX_RE.sub("", text).strip()
        asr_text = _asr_text(data.get("attachments"))
        if asr_text:
            text = "\n".join(part for part in (text, asr_text) if part)
        source = SessionSource(
            platform=self.platform,
            chat_type=chat_type,
            chat_id=chat_id,
            user_id=user_id or None,
            user_name=str(author.get("username") or author.get("nick") or "") or None,
            message_id=message_id,
        )
        return InboundMessage(
            source=source,
            text=text,
            at_bot=at_bot,
            attachments=_attachments(data.get("attachments")),
            quoted_text=_quoted_text(data),
            raw=data,
        )

    async def _drain_unlocked(
        self,
        source: SessionSource,
        room: str,
        key: str,
        *,
        max_items: int | None = None,
    ) -> dict[str, str | None]:
        window = self._reply_windows.get(source.chat_key())
        if window is None or window.error is not None or window.remaining <= 0:
            return {}
        sent: dict[str, str | None] = {}
        items = await self._load_outbox(key)
        count = 0
        while items and window.remaining > 0 and (max_items is None or count < max_items):
            entry = items[0]
            message = _message_from_dict(entry.get("message"))
            result = await self._send_now(source, room, message, window)
            if not result.ok:
                window.error = result.error or "qq.send_failed"
                break
            sent[str(entry.get("id") or "")] = result.message_id
            items.pop(0)
            count += 1
            await self._save_outbox(key, items)
        return sent

    async def _send_now(
        self,
        source: SessionSource,
        room: str,
        message: ChatMessage,
        window: _ReplyWindow,
    ) -> SendResult:
        try:
            if message.attachments:
                result = await self._send_attachment(source, room, message, message.attachments[0], window)
            else:
                result = await self._send_text(source, message, window)
        except Exception as exc:
            code = getattr(exc, "code", "")
            status = getattr(exc, "status", "")
            logger.warning("qq.send_failed status=%s code=%s", status, code)
            return SendResult(ok=False, error=str(exc))
        return result

    async def _send_text(
        self,
        source: SessionSource,
        message: ChatMessage,
        window: _ReplyWindow,
    ) -> SendResult:
        rich = message.markdown and bool(self._markdown_template_id)
        body = self._rich_body(message) if rich else self._plain_body(message)
        try:
            return await self._post_message(source, body, window)
        except QQAPIError as exc:
            if not rich or exc.status not in {400, 403}:
                raise
            return await self._post_message(source, self._plain_body(message), window)

    async def _send_attachment(
        self,
        source: SessionSource,
        room: str,
        message: ChatMessage,
        attachment: ChatAttachment,
        window: _ReplyWindow,
    ) -> SendResult:
        data = attachment.data
        if data is None and attachment.url is None and self._media_store is not None and attachment.id:
            _record, data = await self._media_store.read_bytes(room, attachment.id)
        upload: dict[str, Any] = {"srv_send_msg": False}
        if attachment.url:
            upload["url"] = attachment.url
        elif data is not None:
            if len(data) > MAX_ATTACHMENT_BYTES:
                raise ValueError("qq.media.too_large")
            upload["file_data"] = base64.b64encode(data).decode("ascii")
        else:
            raise FileNotFoundError(attachment.id or attachment.name)

        file_type = _file_type(attachment.mime)
        if file_type == FILE_GENERIC:
            upload["file_name"] = attachment.name
        try:
            uploaded = await self._upload(source, {**upload, "file_type": file_type})
        except QQAPIError as exc:
            if file_type == FILE_AUDIO and exc.status in {400, 403}:
                uploaded = await self._upload(
                    source,
                    {**upload, "file_type": FILE_GENERIC, "file_name": attachment.name},
                )
            else:
                raise

        file_info = str(uploaded.get("file_info") or "")
        if not file_info:
            raise RuntimeError("qq.media.missing_file_info")
        body: dict[str, Any] = {"msg_type": MSG_TYPE_MEDIA, "media": {"file_info": file_info}}
        text = _render_text(message, include_components=False)
        if text:
            body["content"] = text
        return await self._post_message(source, body, window)

    async def _upload(self, source: SessionSource, body: dict[str, Any]) -> dict[str, Any]:
        return await self._transport.send("POST", self._file_path(source), body)

    async def _post_message(
        self,
        source: SessionSource,
        body: dict[str, Any],
        window: _ReplyWindow,
    ) -> SendResult:
        payload = dict(body)
        payload["msg_id"] = window.message_id
        payload["msg_seq"] = window.next_sequence
        data = await self._transport.send("POST", self._message_path(source), payload)
        window.next_sequence += 1
        window.remaining -= 1
        message_id = str(data.get("id") or data.get("message_id") or "") or None
        return SendResult(ok=True, message_id=message_id)

    def _plain_body(self, message: ChatMessage) -> dict[str, Any]:
        return {
            "content": _render_text(message, include_components=True),
            "msg_type": MSG_TYPE_TEXT,
        }

    def _rich_body(self, message: ChatMessage) -> dict[str, Any]:
        body: dict[str, Any] = {
            "msg_type": MSG_TYPE_MARKDOWN,
            "markdown": {
                "custom_template_id": self._markdown_template_id,
                "params": [
                    {
                        "key": "content",
                        "values": [message.text],
                    }
                ],
            },
        }
        if message.components and self._keyboard_enabled:
            body["keyboard"] = _keyboard(message.components)
        elif self._keyboard_id:
            body["keyboard"] = {"id": self._keyboard_id}
        return body

    def _message_path(self, source: SessionSource) -> str:
        if source.chat_type.casefold() == "dm":
            return f"/v2/users/{source.chat_id}/messages"
        return f"/v2/groups/{source.chat_id}/messages"

    def _file_path(self, source: SessionSource) -> str:
        if source.chat_type.casefold() == "dm":
            return f"/v2/users/{source.chat_id}/files"
        return f"/v2/groups/{source.chat_id}/files"

    def _outbox_key(self, source: SessionSource, room: str) -> str:
        return f"qq_outbox.{source.chat_key()}.{room}"

    async def _load_outbox(self, key: str) -> list[dict[str, Any]]:
        raw = await self._store.get(user_key="", store_key=key)
        try:
            value = json.loads(raw) if raw else []
        except json.JSONDecodeError:
            return []
        return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []

    async def _save_outbox(self, key: str, items: list[dict[str, Any]]) -> None:
        if not items:
            await self._store.delete(user_key="", store_key=key)
            return
        await self._store.set(user_key="", store_key=key, value=json.dumps(items, ensure_ascii=False))

    def _append_bounded(self, items: list[dict[str, Any]], item: dict[str, Any]) -> list[dict[str, Any]]:
        coalesce_key = item.get("message", {}).get("coalesce_key")
        if coalesce_key:
            items = [entry for entry in items if entry.get("message", {}).get("coalesce_key") != coalesce_key]
        items.append(item)
        if len(items) <= OUTBOX_MAX_ITEMS:
            return items
        notice = {
            "id": uuid.uuid4().hex,
            "message": _message_to_dict(
                ChatMessage(
                    text=self._i18n.t("qq.outbox_overflow"),
                    coalesce_key="outbox_overflow",
                )
            ),
        }
        items = [entry for entry in items if entry.get("message", {}).get("coalesce_key") != "outbox_overflow"]
        return [notice, *items[-(OUTBOX_MAX_ITEMS - 1) :]]


def _atomic_messages(message: ChatMessage) -> list[ChatMessage]:
    if not message.attachments:
        return [message] if message.text or message.components else []
    return [
        replace(
            message,
            text=message.text if index == 0 else "",
            attachments=[attachment],
        )
        for index, attachment in enumerate(message.attachments)
    ]


def _render_text(message: ChatMessage, *, include_components: bool) -> str:
    if not message.embeds and (not include_components or not message.components):
        return message.text
    lines = [message.text] if message.text else []
    for embed in message.embeds:
        if embed.title:
            lines.append(embed.title)
        if embed.description:
            lines.append(embed.description)
        lines.extend(f"{field.name}: {field.value}" for field in embed.fields)
        if embed.footer:
            lines.append(embed.footer)
    if include_components:
        lines.extend(
            f"{index}. {label} — {command}"
            for index, (label, command, _button_id) in enumerate(_component_commands(message.components), 1)
        )
    return "\n".join(line for line in lines if line)


def _keyboard(components: list[ChatComponent]) -> dict[str, Any]:
    buttons = [
        {
            "id": button_id,
            "render_data": {"label": label, "visited_label": label, "style": 0},
            "action": {"type": 2, "permission": {"type": 0}, "data": command, "enter": True},
        }
        for label, command, button_id in _component_commands(components)
    ]
    return {"content": {"rows": [{"buttons": buttons[index : index + 2]} for index in range(0, len(buttons), 2)]}}


def _component_commands(components: list[ChatComponent]) -> list[tuple[str, str, str]]:
    return [
        (component.label or component.id, component.command, component.id)
        for component in components
        if component.command
    ]


def _attachments(value: Any) -> list[ChatAttachment]:
    if not isinstance(value, list):
        return []
    attachments: list[ChatAttachment] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        content_type = str(item.get("content_type") or "").casefold()
        voice_wav_url = str(item.get("voice_wav_url") or "")
        url = voice_wav_url or str(item.get("url") or "") or None
        name = str(item.get("filename") or "attachment")
        if voice_wav_url:
            mime = "audio/wav"
            if not name.casefold().endswith(".wav"):
                name = f"{name.rsplit('.', 1)[0]}.wav"
        else:
            guessed_mime = mimetypes.guess_type(name)[0]
            if content_type in {"", "file", "application/octet-stream"}:
                mime = guessed_mime or "application/octet-stream"
            else:
                mime = content_type
        try:
            size = int(item.get("size") or 0)
        except (TypeError, ValueError):
            size = 0
        attachments.append(
            ChatAttachment(
                id=str(url or name),
                name=name,
                mime=mime,
                size=size,
                url=url,
            )
        )
    return attachments


def _asr_text(value: Any) -> str:
    if not isinstance(value, list):
        return ""
    return "\n".join(
        text
        for item in value
        if isinstance(item, dict)
        and (text := str(item.get("asr_refer_text") or "").strip())
    )


def _quoted_text(data: dict[str, Any]) -> str:
    scene = data.get("message_scene")
    extensions = scene.get("ext") if isinstance(scene, dict) else None
    has_reference = str(data.get("message_type") or "") == "103" or (
        isinstance(extensions, list)
        and any(str(item).startswith("ref_msg_idx=") for item in extensions)
    )
    if not has_reference:
        return ""
    elements = data.get("msg_elements")
    if isinstance(elements, list) and elements and isinstance(elements[0], dict):
        return str(elements[0].get("content") or "").strip()
    return ""


def _file_type(mime: str) -> int:
    if mime.startswith("image/"):
        return FILE_IMAGE
    if mime.startswith("video/"):
        return FILE_VIDEO
    if mime.startswith("audio/"):
        return FILE_AUDIO
    return FILE_GENERIC


def _message_to_dict(message: ChatMessage) -> dict[str, Any]:
    return {
        "text": _render_text(message, include_components=False),
        "markdown": message.markdown,
        "attachments": [
            {
                "id": item.id,
                "name": item.name,
                "mime": item.mime,
                "size": item.size,
                "url": item.url,
            }
            for item in message.attachments
        ],
        "buttons": [
            {"id": button_id, "label": label, "command": command}
            for label, command, button_id in _component_commands(message.components)
        ],
        "coalesce_key": message.coalesce_key,
    }


def _message_from_dict(value: Any) -> ChatMessage:
    value = value if isinstance(value, dict) else {}
    return ChatMessage(
        text=str(value.get("text") or ""),
        markdown=bool(value.get("markdown")),
        attachments=[ChatAttachment(**item) for item in value.get("attachments", []) if isinstance(item, dict)],
        components=[
            ChatComponent(
                id=str(item.get("id") or ""),
                command=str(item.get("command") or ""),
                label=str(item.get("label") or ""),
            )
            for item in value.get("buttons", [])
            if isinstance(item, dict)
        ],
        coalesce_key=str(value.get("coalesce_key") or "") or None,
    )


async def _response_json(response: aiohttp.ClientResponse) -> dict[str, Any]:
    try:
        value = await response.json(content_type=None)
    except (aiohttp.ContentTypeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _api_error(status: int, data: dict[str, Any]) -> QQAPIError:
    return QQAPIError(status, str(data.get("code") or data.get("err_code") or ""))


def _parse_json(raw: Any) -> dict[str, Any] | None:
    try:
        value = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _from_context(config: QQSettings, context: AdapterContext) -> QQOfficialAdapter:
    services = context.services
    tui = services.settings.tui
    media_store = MediaStore(
        services.store,
        services.settings.data_dir,
        max_file_bytes=MAX_ATTACHMENT_BYTES,
        room_quota_bytes=max(tui.media_room_quota_bytes, tui.audio_room_quota_bytes),
        allowed_mimes=ALLOWED_CHAT_ATTACHMENT_MIMES,
    )
    return QQOfficialAdapter(
        config,
        store=services.store,
        media_store=media_store,
        locale=services.settings.locale,
    )


platform_registry.register(
    PlatformEntry(
        name="qq",
        label="QQ",
        adapter_factory=_from_context,
        check_fn=lambda: True,
    )
)
