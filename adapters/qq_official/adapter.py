"""Official QQ platform adapter.

Trimmed from hermes-agent's raw QQ Bot API adapter design (MIT, Copyright
2025 Nous Research). This module intentionally avoids the QQ SDK; aiohttp/httpx
are optional and network I/O can be fully replaced by an injected transport.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import re
import time
import uuid
from collections import OrderedDict
from typing import Any

try:  # pragma: no cover - exercised only by live transport users.
    import aiohttp
except ImportError:  # pragma: no cover
    aiohttp = None  # type: ignore[assignment]

try:  # pragma: no cover - exercised only by live transport users.
    import httpx
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore[assignment]

from gateway.base_adapter import BaseAdapter, MessageHandler
from gateway.events import InboundMessage, SendResult
from gateway.ops import ContentSanitizer
from gateway.registry import PlatformEntry, platform_registry
from gateway.session import SessionSource
from infra.i18n import t
from infra.store import Store

logger = logging.getLogger(__name__)

API_BASE = "https://api.sgroup.qq.com"
TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"
GATEWAY_URL_PATH = "/gateway"
GROUP_AT_MESSAGE_CREATE = "GROUP_AT_MESSAGE_CREATE"
GROUP_MESSAGE_CREATE = "GROUP_MESSAGE_CREATE"
C2C_MESSAGE_CREATE = "C2C_MESSAGE_CREATE"
INTENTS = (1 << 25) | (1 << 12) | (1 << 26)
MSG_TYPE_TEXT = 0
MAX_MESSAGE_LENGTH = 2000
_GROUP_MODE_PREFIX = "qq_group_mode."
_HINT_SENT_PREFIX = "qq_hint_sent."
_PENDING_PREFIX = "qq_pending_narration."
_MODE_AT_ONLY = "at_only"
_MODE_FULL = "full"
_SENTINEL_YES = "1"
_DIRECT_CHAT_TYPES = {"dm", "c2c", "private", "direct"}
_AT_PREFIX_RE = re.compile(r"^(?:<@!?[^>]+>|@\S+)\s*")
# Caps for the recent-id dedup structures so their memory stays bounded over a
# long-lived process instead of growing without limit (one bad actor spamming
# unique ids would otherwise leak memory forever).
_SEEN_IDS_MAX = 4096
_HINT_SENT_MAX = 1024


class _BoundedIdSet:
    """A bounded, insertion-ordered membership set for recent-id dedup.

    Backed by an ``OrderedDict`` used as an ordered set: once it grows past
    ``maxsize`` the oldest id is evicted (FIFO), so membership memory stays
    bounded while the most-recent ids are still remembered for deduping.
    Supports the two operations the adapter needs — ``id in self`` and
    ``self.add(id)`` — so it drops in for the plain ``set`` it replaces.
    """

    def __init__(self, maxsize: int) -> None:
        self._maxsize = max(1, maxsize)
        self._ids: OrderedDict[str, None] = OrderedDict()

    def __contains__(self, key: str) -> bool:
        return key in self._ids

    def __len__(self) -> int:
        return len(self._ids)

    def add(self, key: str) -> None:
        if key in self._ids:
            self._ids.move_to_end(key)
            return
        self._ids[key] = None
        if len(self._ids) > self._maxsize:
            self._ids.popitem(last=False)


class _DefaultQQTransport:
    def __init__(self, *, app_id: str, secret: str, token: str | None = None) -> None:
        self._app_id = app_id
        self._secret = secret
        self._access_token = token or ""
        self._token_expires_at = 0.0
        self._http_client: Any = None
        self._ws_session: Any = None
        self._ws: Any = None

    async def ws(self, on_payload) -> None:
        if aiohttp is None:
            raise RuntimeError("qq.dependency.aiohttp")
        gateway_url = await self._gateway_url()
        self._ws_session = aiohttp.ClientSession(trust_env=True)
        self._ws = await self._ws_session.ws_connect(gateway_url)
        await self._consume(self._ws, on_payload)

    async def _consume(self, ws: Any, on_payload) -> None:
        """Drain `ws`, dispatching each TEXT payload to `on_payload`.

        Each payload is dispatched under its own guard: a single raising payload
        (a malformed frame, or a turn that blew up) is logged and skipped, never
        propagated — otherwise it would break out of `async for` and permanently
        kill the listener task (the bot silently disconnects until restart)."""
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                payload = _parse_json(msg.data)
                if payload is not None:
                    try:
                        await on_payload(payload)
                    except Exception:
                        # One bad payload / crashing turn must not kill the listener loop.
                        logger.warning("qq.payload_failed", exc_info=True)
            elif msg.type in {aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR}:
                break

    async def send_ws(self, payload: dict[str, Any]) -> None:
        if self._ws is not None and not self._ws.closed:
            await self._ws.send_json(payload)

    async def send(self, method: str, path: str, body: dict[str, Any]) -> dict[str, Any]:
        return await self._request(method, path, body)

    async def close(self) -> None:
        if self._ws is not None and not self._ws.closed:
            await self._ws.close()
        self._ws = None
        if self._ws_session is not None and not self._ws_session.closed:
            await self._ws_session.close()
        self._ws_session = None
        if self._http_client is not None:
            await self._http_client.aclose()
        self._http_client = None

    async def _gateway_url(self) -> str:
        data = await self._request("GET", GATEWAY_URL_PATH, None)
        url = str(data.get("url") or "")
        if not url:
            raise RuntimeError("qq.gateway.missing_url")
        return url

    async def _request(self, method: str, path: str, body: dict[str, Any] | None) -> dict[str, Any]:
        if httpx is None:
            raise RuntimeError("qq.dependency.httpx")
        token = await self._token()
        client = await self._client()
        response = await client.request(
            method,
            f"{API_BASE}{path}",
            json=body,
            headers={"Authorization": f"QQBot {token}"},
        )
        response.raise_for_status()
        data = response.json()
        return data if isinstance(data, dict) else {}

    async def _client(self):
        if self._http_client is None:
            self._http_client = httpx.AsyncClient(timeout=30.0, follow_redirects=True)
        return self._http_client

    async def _token(self) -> str:
        if self._access_token and time.time() < self._token_expires_at - 60:
            return self._access_token
        if not self._app_id or not self._secret:
            raise RuntimeError("qq.credentials.missing")
        if httpx is None:
            raise RuntimeError("qq.dependency.httpx")
        client = await self._client()
        response = await client.post(
            TOKEN_URL,
            json={"appId": self._app_id, "clientSecret": self._secret},
        )
        response.raise_for_status()
        data = response.json()
        token = str(data.get("access_token") or "")
        if not token:
            raise RuntimeError("qq.token.missing")
        self._access_token = token
        self._token_expires_at = time.time() + int(data.get("expires_in") or 7200)
        return token


class QQOfficialAdapter(BaseAdapter):
    platform = "qq"
    INTENTS = INTENTS
    intents = INTENTS

    def __init__(
        self,
        config: Any = None,
        *,
        transport: Any | None = None,
        store: Store | None = None,
        on_message: MessageHandler | None = None,
    ) -> None:
        super().__init__(config=config, on_message=on_message)
        self._app_id = self._config_value("app_id", "appid", default="")
        self._secret = self._config_value("secret", "client_secret", "clientSecret", default="")
        self._token = self._config_value("token", "access_token", default="")
        self._store = store or self._config_value("store", default=None) or Store(":memory:")
        self._locale = self._config_value("locale", default=None)
        self._transport = transport or _DefaultQQTransport(
            app_id=self._app_id,
            secret=self._secret,
            token=self._token or None,
        )
        self._sanitizer = ContentSanitizer(locale=self._locale)
        self._group_modes: dict[str, str] = {}
        self._hint_sent: _BoundedIdSet = _BoundedIdSet(_HINT_SENT_MAX)
        self._seen_message_ids: _BoundedIdSet = _BoundedIdSet(_SEEN_IDS_MAX)
        self._listen_task: asyncio.Task | None = None
        self._session_id: str | None = None
        self._last_seq: int | None = None

    async def connect(self) -> bool:
        ws = getattr(self._transport, "ws", None)
        if ws is None:
            return True
        try:
            ws_result = ws(self.dispatch_payload)
        except TypeError:
            ws_result = ws()
        if inspect.isawaitable(ws_result):
            self._listen_task = asyncio.create_task(ws_result)
        return True

    async def disconnect(self) -> None:
        if self._listen_task is not None:
            self._listen_task.cancel()
            try:
                await self._listen_task
            except asyncio.CancelledError:
                pass
            self._listen_task = None
        close = getattr(self._transport, "close", None)
        if close is not None:
            result = close()
            if inspect.isawaitable(result):
                await result

    def supports_proactive(self, source: SessionSource) -> bool:
        if source.chat_type.lower() in _DIRECT_CHAT_TYPES:
            return True
        if source.chat_type != "group":
            return False
        return self._group_modes.get(str(source.chat_id), _MODE_AT_ONLY) == _MODE_FULL

    async def send(self, source: SessionSource, content: str, *, reply_to: str | None = None) -> SendResult:
        if not content or not content.strip():
            return SendResult(ok=True)
        if source.chat_type == "group" and reply_to is None and not await self._is_group_full(source.chat_id):
            await self._queue_pending(source.chat_id, content)
            return SendResult(ok=False, error="qq.proactive.queued")

        body = self._build_text_body(content, reply_to)
        path = self._message_path(source)
        try:
            data = await self._send_via_transport(path, body)
        except Exception as exc:
            logger.warning("qq.send_failed %s", exc)
            return SendResult(ok=False, error=str(exc))

        if source.chat_type == "group" and reply_to is None:
            await self._set_group_mode(source.chat_id, _MODE_FULL)

        if isinstance(data, SendResult):
            return data
        if isinstance(data, dict):
            message_id = str(data.get("id") or data.get("message_id") or uuid.uuid4().hex[:12])
        else:
            message_id = uuid.uuid4().hex[:12]
        return SendResult(ok=True, message_id=message_id)

    async def dispatch_payload(self, payload: dict[str, Any]) -> None:
        op = payload.get("op")
        event_type = str(payload.get("t") or "")
        data = payload.get("d")
        seq = payload.get("s")
        if isinstance(seq, int) and (self._last_seq is None or seq > self._last_seq):
            self._last_seq = seq

        if op == 10:
            await self._send_identify()
            return
        if op == 0 and event_type == "READY":
            if isinstance(data, dict):
                self._session_id = str(data.get("session_id") or "")
            return
        if op not in {0, None}:
            return
        if event_type in {GROUP_AT_MESSAGE_CREATE, GROUP_MESSAGE_CREATE, C2C_MESSAGE_CREATE}:
            await self._on_message(event_type, data)

    async def _dispatch_payload(self, payload: dict[str, Any]) -> None:
        await self.dispatch_payload(payload)

    async def _on_message(self, event_type: str, data: Any) -> None:
        if not isinstance(data, dict):
            return
        message_id = str(data.get("id") or "")
        if not message_id or message_id in self._seen_message_ids:
            return
        self._seen_message_ids.add(message_id)
        if event_type == C2C_MESSAGE_CREATE:
            msg = self._build_c2c_message(data, message_id)
            if msg is not None:
                await self.handle_inbound(msg)
            return

        if event_type in {GROUP_AT_MESSAGE_CREATE, GROUP_MESSAGE_CREATE}:
            at_bot = event_type == GROUP_AT_MESSAGE_CREATE
            # An unaddressed (non-@) group message must NOT auto-promote the group to
            # FULL proactive mode: a single stray message would otherwise un-gate
            # unsolicited bot push. The prior mode is kept; FULL is reached only by an
            # explicit keeper opt-in (a stored `qq_group_mode` = full).
            msg = self._build_group_message(data, message_id, at_bot=at_bot)
            if msg is None:
                return
            await self._flush_pending_on_inbound(msg.source)
            if at_bot and not await self._is_group_full(msg.source.chat_id):
                await self._maybe_send_enable_hint(msg.source)
            await self.handle_inbound(msg)

    def _build_group_message(self, data: dict[str, Any], message_id: str, *, at_bot: bool) -> InboundMessage | None:
        group_openid = str(data.get("group_openid") or data.get("group_id") or "")
        if not group_openid:
            return None
        author = data.get("author") if isinstance(data.get("author"), dict) else {}
        user_id = str(
            author.get("member_openid")
            or data.get("member_openid")
            or author.get("user_openid")
            or author.get("id")
            or ""
        )
        text = str(data.get("content") or "").strip()
        if at_bot:
            text = _AT_PREFIX_RE.sub("", text).strip()
        source = SessionSource(
            platform=self.platform,
            chat_type="group",
            chat_id=group_openid,
            user_id=user_id or None,
            message_id=message_id,
        )
        return InboundMessage(source=source, text=text, at_bot=at_bot, raw=data)

    def _build_c2c_message(self, data: dict[str, Any], message_id: str) -> InboundMessage | None:
        author = data.get("author") if isinstance(data.get("author"), dict) else {}
        user_openid = str(author.get("user_openid") or data.get("user_openid") or data.get("openid") or "")
        if not user_openid:
            return None
        source = SessionSource(
            platform=self.platform,
            chat_type="dm",
            chat_id=user_openid,
            user_id=user_openid,
            message_id=message_id,
        )
        return InboundMessage(source=source, text=str(data.get("content") or "").strip(), at_bot=False, raw=data)

    async def _send_identify(self) -> None:
        send_ws = getattr(self._transport, "send_ws", None)
        if send_ws is None:
            return
        token = self._token
        if not token:
            token_fn = getattr(self._transport, "_token", None)
            if token_fn is not None:
                token = await token_fn()
        payload = {
            "op": 2,
            "d": {
                "token": f"QQBot {token}",
                "intents": INTENTS,
                "shard": [0, 1],
                "properties": {
                    "$os": "python",
                    "$browser": "trpg-kp",
                    "$device": "trpg-kp",
                },
            },
        }
        result = send_ws(payload)
        if inspect.isawaitable(result):
            await result

    async def _maybe_send_enable_hint(self, source: SessionSource) -> None:
        group_id = str(source.chat_id)
        if group_id in self._hint_sent:
            return
        store_key = f"{_HINT_SENT_PREFIX}{group_id}"
        if await self._store.get(store_key=store_key) == _SENTINEL_YES:
            self._hint_sent.add(group_id)
            return
        self._hint_sent.add(group_id)
        await self._store.set(store_key=store_key, value=_SENTINEL_YES)
        await self.send(source, t("qq.enable_full_hint", locale=self._locale), reply_to=source.message_id)

    async def _flush_pending_on_inbound(self, source: SessionSource) -> None:
        group_id = str(source.chat_id)
        store_key = f"{_PENDING_PREFIX}{group_id}"
        raw = await self._store.get(store_key=store_key)
        pending = _decode_pending(raw)
        if not pending:
            return
        await self._store.delete(store_key=store_key)
        note = t("qq.pending_flush_prefix", locale=self._locale)
        content = "\n".join([note, *pending]).strip()
        result = await self.send(source, content, reply_to=source.message_id)
        if not result.ok:
            await self._store.set(store_key=store_key, value=json.dumps(pending, ensure_ascii=False))

    async def _queue_pending(self, group_id: str, content: str) -> None:
        store_key = f"{_PENDING_PREFIX}{group_id}"
        pending = _decode_pending(await self._store.get(store_key=store_key))
        pending.append(content)
        await self._store.set(store_key=store_key, value=json.dumps(pending, ensure_ascii=False))

    async def _is_group_full(self, group_id: str) -> bool:
        group_id = str(group_id)
        if self._group_modes.get(group_id) == _MODE_FULL:
            return True
        value = await self._store.get(store_key=f"{_GROUP_MODE_PREFIX}{group_id}")
        mode = _MODE_FULL if value == _MODE_FULL else _MODE_AT_ONLY
        self._group_modes[group_id] = mode
        return mode == _MODE_FULL

    async def _set_group_mode(self, group_id: str, mode: str) -> None:
        if not group_id or mode not in {_MODE_AT_ONLY, _MODE_FULL}:
            return
        self._group_modes[group_id] = mode
        await self._store.set(store_key=f"{_GROUP_MODE_PREFIX}{group_id}", value=mode)

    def _message_path(self, source: SessionSource) -> str:
        if source.chat_type.lower() in _DIRECT_CHAT_TYPES:
            return f"/v2/users/{source.chat_id}/messages"
        return f"/v2/groups/{source.chat_id}/messages"

    def _build_text_body(self, content: str, reply_to: str | None) -> dict[str, Any]:
        body: dict[str, Any] = {
            "content": self._sanitizer.sanitize_outbound(content)[:MAX_MESSAGE_LENGTH],
            "msg_type": MSG_TYPE_TEXT,
            "msg_seq": _next_msg_seq(reply_to or content),
        }
        if reply_to:
            body["msg_id"] = reply_to
        return body

    async def _send_via_transport(self, path: str, body: dict[str, Any]) -> Any:
        send = self._transport.send
        try:
            return await send("POST", path, body)
        except TypeError:
            try:
                return await send(path, body)
            except TypeError:
                return await send(body)

    def _config_value(self, *names: str, default: Any = None) -> Any:
        if self.config is None:
            return default
        for name in names:
            if isinstance(self.config, dict) and name in self.config:
                return self.config[name]
            if hasattr(self.config, name):
                return getattr(self.config, name)
        extra = getattr(self.config, "extra", None)
        if isinstance(extra, dict):
            for name in names:
                if name in extra:
                    return extra[name]
        return default


def _decode_pending(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return [raw]
    if not isinstance(data, list):
        return []
    return [str(item) for item in data if str(item).strip()]


def _next_msg_seq(seed: str) -> int:
    return (int(time.time()) ^ int(uuid.uuid5(uuid.NAMESPACE_URL, seed).hex[:4], 16)) % 65536


def _parse_json(raw: Any) -> dict[str, Any] | None:
    try:
        data = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


platform_registry.register(
    PlatformEntry(
        name="qq",
        label="QQ",
        adapter_factory=lambda cfg: QQOfficialAdapter(cfg),
        check_fn=lambda: True,
    )
)
