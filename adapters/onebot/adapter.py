"""OneBot 11 adapter with forward and reverse universal WebSocket transports."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hmac
import inspect
import ipaddress
import itertools
import json
import logging
import math
import mimetypes
import re
import socket
from collections import OrderedDict
from dataclasses import replace
from http import HTTPStatus
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import urljoin, urlparse

import aiohttp
import websockets

from gateway.base_adapter import BaseAdapter, MessageHandler
from gateway.chat import ChatAttachment, ChatCapabilities, ChatMessage
from gateway.events import InboundMessage, SendResult
from gateway.registry import PlatformEntry, platform_registry
from gateway.session import SessionSource

logger = logging.getLogger(__name__)

MAX_TEXT_CHARS = 4000
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
DEFAULT_REQUEST_TIMEOUT = 10.0
DEFAULT_RECONNECT_DELAY = 1.0
DEFAULT_REVERSE_PATH = "/onebot/v11/ws"
RECENT_MESSAGE_LIMIT = 2048
EVENT_QUEUE_LIMIT = 256
MAX_WEBSOCKET_FRAME_BYTES = 4 * ((MAX_ATTACHMENT_BYTES + 2) // 3) + 1024 * 1024
MAX_ATTACHMENT_REDIRECTS = 5
_DIRECT_CHAT_TYPES = {"dm", "direct", "private", "c2c"}
_CQ_CODE_RE = re.compile(r"\[CQ:([A-Za-z0-9_.-]+)(?:,([^\]]*))?\]")
_ATTACHMENT_TYPES = {"image", "record", "video", "file"}


class OneBotAPIError(RuntimeError):
    """A failed OneBot action response."""

    def __init__(self, retcode: int, wording: str = "") -> None:
        self.retcode = retcode
        self.wording = wording
        suffix = f".{wording}" if wording else ""
        super().__init__(f"onebot.api.{retcode}{suffix}")


class _PublicAddressResolver(aiohttp.abc.AbstractResolver):
    """Resolve only globally routable addresses, including every redirect hop."""

    def __init__(self, resolver: Any | None = None) -> None:
        self._resolver = resolver or aiohttp.resolver.DefaultResolver()

    async def resolve(
        self,
        host: str,
        port: int = 0,
        family: socket.AddressFamily = socket.AF_INET,
    ) -> list[dict[str, Any]]:
        addresses = await self._resolver.resolve(host, port, family=family)
        if not addresses or any(
            not _is_public_ip(str(item.get("host") or "")) for item in addresses
        ):
            raise OSError("onebot.attachment.unsafe_address")
        return addresses

    async def close(self) -> None:
        await self._resolver.close()


class _ActionWebSocketTransport:
    """Shared action/echo correlation for OneBot universal WebSockets."""

    def __init__(self, *, request_timeout: float = DEFAULT_REQUEST_TIMEOUT) -> None:
        if not math.isfinite(request_timeout) or request_timeout <= 0:
            raise ValueError("onebot.request_timeout.invalid")
        self.request_timeout = request_timeout
        self._connection: Any | None = None
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._sequence = itertools.count(1)
        self._send_lock = asyncio.Lock()
        self._connected = asyncio.Event()
        self._event_handler: Any | None = None
        self._event_queues: dict[str, asyncio.Queue[dict[str, Any]]] = {}
        self._event_workers: dict[str, asyncio.Task[None]] = {}
        self._pending_events = 0

    @property
    def connected(self) -> bool:
        return self._connection is not None

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    async def wait_connected(self, timeout: float = DEFAULT_REQUEST_TIMEOUT) -> None:
        await asyncio.wait_for(self._connected.wait(), timeout)

    async def call(self, action: str, params: dict[str, Any]) -> Any:
        connection = self._connection
        if connection is None:
            raise ConnectionError("onebot.websocket.not_connected")

        echo = f"loreweaver-{next(self._sequence)}"
        future = asyncio.get_running_loop().create_future()
        self._pending[echo] = future
        payload = json.dumps(
            {"action": action, "params": params, "echo": echo},
            ensure_ascii=False,
        )
        try:
            async with self._send_lock:
                if self._connection is not connection:
                    raise ConnectionError("onebot.websocket.disconnected")
                await connection.send(payload)
            response = await asyncio.wait_for(future, self.request_timeout)
        except BaseException:
            pending = self._pending.pop(echo, None)
            if pending is not None and not pending.done():
                pending.cancel()
            raise

        status = str(response.get("status") or "").casefold()
        retcode = _integer(response.get("retcode"), default=-1)
        if status != "ok" or retcode != 0:
            wording = str(response.get("wording") or response.get("message") or "")
            raise OneBotAPIError(retcode, wording)
        return response.get("data")

    async def _consume(self, connection: Any) -> None:
        async for raw in connection:
            payload = _json_object(raw)
            if payload is None:
                logger.warning("onebot.invalid_websocket_payload")
                continue

            if "echo" in payload:
                echo = str(payload.get("echo"))
                future = self._pending.pop(echo, None)
                if future is not None and not future.done():
                    future.set_result(payload)
                # A timed-out or otherwise unknown action response is still a
                # response, never an event. Dropping it prevents duplicate turns.
                continue

            # Event handling may synchronously issue an action on this same
            # universal socket. Per-chat ordered workers keep this receive loop
            # free to resolve action echoes while allowing unrelated rooms to
            # progress concurrently. On bounded-backlog exhaustion, close the
            # socket explicitly so the implementation can reconnect/redeliver;
            # silently dropping an already-received turn is never acceptable.
            if not self._queue_event(payload):
                logger.error("onebot.event_backlog_exhausted")
                with contextlib.suppress(Exception):
                    await connection.close(code=1013, reason="event backlog exhausted")
                return

    def _start_dispatcher(self, handler: Any) -> None:
        self._event_handler = handler

    async def _stop_dispatcher(self) -> None:
        workers = list(self._event_workers.values())
        for worker in workers:
            worker.cancel()
        if workers:
            await asyncio.gather(*workers, return_exceptions=True)
        self._event_workers.clear()
        self._event_handler = None
        self._event_queues.clear()
        self._pending_events = 0

    def _queue_event(self, payload: dict[str, Any]) -> bool:
        if self._event_handler is None or self._pending_events >= EVENT_QUEUE_LIMIT:
            return False
        key = _event_partition(payload)
        queue = self._event_queues.setdefault(key, asyncio.Queue())
        queue.put_nowait(payload)
        self._pending_events += 1
        worker = self._event_workers.get(key)
        if worker is None or worker.done():
            self._event_workers[key] = asyncio.create_task(
                self._dispatch_events(key, queue),
                name=f"onebot-event-dispatch:{key}",
            )
        return True

    async def _dispatch_events(
        self,
        key: str,
        queue: asyncio.Queue[dict[str, Any]],
    ) -> None:
        try:
            while True:
                try:
                    payload = queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
                try:
                    result = self._event_handler(payload)
                    if inspect.isawaitable(result):
                        await result
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception("onebot.event_handler_failed")
                finally:
                    self._pending_events -= 1
                    queue.task_done()
        finally:
            self._event_workers.pop(key, None)
            self._event_queues.pop(key, None)

    def _attach(self, connection: Any) -> Any | None:
        previous = self._connection
        if previous is not None and previous is not connection:
            self._detach(previous)
        self._connection = connection
        self._connected.set()
        return previous

    def _detach(self, connection: Any) -> None:
        if self._connection is not connection:
            return
        self._connection = None
        self._connected.clear()
        pending = list(self._pending.values())
        self._pending.clear()
        for future in pending:
            if not future.done():
                future.set_exception(ConnectionError("onebot.websocket.disconnected"))


class OneBotForwardWebSocketTransport(_ActionWebSocketTransport):
    """OneBot 11 forward universal WebSocket client with reconnection."""

    def __init__(
        self,
        url: str,
        *,
        access_token: str = "",
        request_timeout: float = DEFAULT_REQUEST_TIMEOUT,
        reconnect_delay: float = DEFAULT_RECONNECT_DELAY,
        connect_factory: Any = websockets.connect,
    ) -> None:
        super().__init__(request_timeout=request_timeout)
        if not _valid_ws_url(url):
            raise ValueError("onebot.websocket.url.invalid")
        if not math.isfinite(reconnect_delay) or reconnect_delay < 0:
            raise ValueError("onebot.reconnect_delay.invalid")
        self.url = url
        self.access_token = access_token
        self.reconnect_delay = reconnect_delay
        self._connect_factory = connect_factory
        self._handler: Any | None = None
        self._runner: asyncio.Task[None] | None = None
        self._closing = False

    async def start(self, handler: Any) -> None:
        if self._runner is not None and not self._runner.done():
            return
        self._handler = handler
        self._start_dispatcher(handler)
        self._closing = False
        self._runner = asyncio.create_task(self._run(), name="onebot-forward-ws")
        # Let an immediately available loopback endpoint accept before connect()
        # returns, while keeping an unavailable endpoint non-blocking.
        await asyncio.sleep(0)

    async def close(self) -> None:
        self._closing = True
        connection = self._connection
        if connection is not None:
            with contextlib.suppress(Exception):
                await connection.close()
        runner = self._runner
        if runner is not None:
            runner.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await runner
        if connection is not None:
            self._detach(connection)
        self._runner = None
        await self._stop_dispatcher()

    async def _run(self) -> None:
        headers = (
            {"Authorization": f"Bearer {self.access_token}"}
            if self.access_token
            else None
        )
        while not self._closing:
            connection = None
            try:
                async with self._connect_factory(
                    self.url,
                    additional_headers=headers,
                    open_timeout=self.request_timeout,
                    max_size=MAX_WEBSOCKET_FRAME_BYTES,
                ) as connection:
                    self._attach(connection)
                    await self._consume(connection)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if not self._closing:
                    logger.warning("onebot.forward_connection_lost error=%s", type(exc).__name__)
            finally:
                if connection is not None:
                    self._detach(connection)
            if not self._closing:
                await asyncio.sleep(self.reconnect_delay)


class OneBotReverseWebSocketTransport(_ActionWebSocketTransport):
    """OneBot 11 reverse universal WebSocket listener."""

    def __init__(
        self,
        host: str,
        port: int,
        *,
        path: str = DEFAULT_REVERSE_PATH,
        access_token: str = "",
        request_timeout: float = DEFAULT_REQUEST_TIMEOUT,
        serve_factory: Any = websockets.serve,
    ) -> None:
        super().__init__(request_timeout=request_timeout)
        if not _is_loopback_host(host) and not access_token.strip():
            raise ValueError("onebot.reverse.public_auth_required")
        self.host = host
        self.port = port
        self.path = _normalize_path(path)
        self.access_token = access_token
        self._serve_factory = serve_factory
        self._handler: Any | None = None
        self._server: Any | None = None

    @property
    def bound_port(self) -> int | None:
        sockets = getattr(self._server, "sockets", None) or []
        return int(sockets[0].getsockname()[1]) if sockets else None

    async def start(self, handler: Any) -> None:
        if self._server is not None:
            return
        self._handler = handler
        self._start_dispatcher(handler)
        try:
            self._server = await self._serve_factory(
                self._accept,
                self.host,
                self.port,
                process_request=self._process_request,
                max_size=MAX_WEBSOCKET_FRAME_BYTES,
            )
        except BaseException:
            await self._stop_dispatcher()
            raise

    async def close(self) -> None:
        connection = self._connection
        if connection is not None:
            with contextlib.suppress(Exception):
                await connection.close()
            self._detach(connection)
        server = self._server
        if server is not None:
            server.close()
            await server.wait_closed()
        self._server = None
        await self._stop_dispatcher()

    def _process_request(self, connection: Any, request: Any) -> Any | None:
        path = str(request.path).partition("?")[0]
        if path != self.path:
            return connection.respond(HTTPStatus.NOT_FOUND, "")

        authorization = str(request.headers.get("Authorization") or "")
        expected = f"Bearer {self.access_token}" if self.access_token else ""
        if expected and not hmac.compare_digest(authorization, expected):
            return connection.respond(HTTPStatus.UNAUTHORIZED, "")

        role = str(request.headers.get("X-Client-Role") or "").casefold()
        if role and role != "universal":
            return connection.respond(HTTPStatus.BAD_REQUEST, "")
        return None

    async def _accept(self, connection: Any) -> None:
        previous = self._attach(connection)
        if previous is not None:
            with contextlib.suppress(Exception):
                await previous.close(code=1012)
        try:
            await self._consume(connection)
        finally:
            self._detach(connection)


class OneBotAdapter(BaseAdapter):
    """Translate OneBot 11 message events to the shared gateway contract."""

    platform = "onebot"
    capabilities = ChatCapabilities(attachments=True, max_text_chars=MAX_TEXT_CHARS)

    def __init__(
        self,
        config: Any = None,
        *,
        transport: Any | None = None,
        on_message: MessageHandler | None = None,
        http_session: aiohttp.ClientSession | Any | None = None,
    ) -> None:
        super().__init__(config=config, on_message=on_message)
        self._transport = transport if transport is not None else _build_transport(config)
        self._http_session = http_session
        self._owns_http_session = http_session is None
        self._attachment_timeout = (
            _float_value(
                _config_value(config, "request_timeout"),
                DEFAULT_REQUEST_TIMEOUT,
                allow_zero=False,
            )
            or DEFAULT_REQUEST_TIMEOUT
        )
        self._recent_messages: OrderedDict[tuple[str, str, str, str], None] = OrderedDict()

    async def connect(self) -> bool:
        if self._transport is None:
            return False
        await _maybe_await(self._transport.start(self.handle_event))
        if isinstance(self._transport, OneBotForwardWebSocketTransport):
            # start() only schedules the dial; without this wait an unreachable
            # forward endpoint would be reported as a successful connect and the
            # background retry loop would hide the misconfiguration forever.
            timeout = getattr(self._transport, "request_timeout", self._attachment_timeout)
            try:
                await self._transport.wait_connected(timeout)
            except TimeoutError:
                logger.warning("onebot.forward_connect_timeout url=%s", self._transport.url)
                await self._transport.close()
                return False
        return True

    async def disconnect(self) -> None:
        try:
            if self._transport is not None:
                await _maybe_await(self._transport.close())
        finally:
            if self._owns_http_session and self._http_session is not None:
                await self._http_session.close()
                self._http_session = None

    def parse_event(self, event: dict[str, Any]) -> InboundMessage | None:
        # OneBot implementations may emit the bot's own sends as message_sent.
        # Accepting only message and also checking self_id closes both loop paths.
        if event.get("post_type") != "message":
            return None
        message_type = str(event.get("message_type") or "").casefold()
        if message_type not in {"group", "private"}:
            return None

        self_id = _string_id(event.get("self_id"))
        user_id = _string_id(event.get("user_id"))
        if user_id is None or (self_id is not None and user_id == self_id):
            return None

        if message_type == "group":
            chat_id = _string_id(event.get("group_id"))
            chat_type = "group"
        else:
            chat_id = user_id
            chat_type = "dm"
        if chat_id is None:
            return None

        raw_message = event.get("message")
        if not isinstance(raw_message, (str, list)):
            raw_message = event.get("raw_message")
        text, at_bot, attachments = _decode_message(raw_message, self_id)
        if not text and not attachments:
            return None

        sender = event.get("sender") if isinstance(event.get("sender"), dict) else {}
        source = SessionSource(
            platform=self.platform,
            chat_type=chat_type,
            chat_id=chat_id,
            user_id=user_id,
            user_name=_sender_name(sender),
            message_id=_string_id(event.get("message_id")),
            is_bot=False,
        )
        return InboundMessage(
            source=source,
            text=text,
            at_bot=at_bot,
            attachments=attachments,
            raw=event,
        )

    async def handle_event(self, event: dict[str, Any]) -> InboundMessage | None:
        inbound = self.parse_event(event)
        if inbound is None:
            return None
        message_id = inbound.source.message_id
        if message_id is not None:
            key = (
                str(event.get("self_id") or ""),
                inbound.source.chat_type,
                inbound.source.chat_id,
                message_id,
            )
            if key in self._recent_messages:
                self._recent_messages.move_to_end(key)
                return None
            self._recent_messages[key] = None
            while len(self._recent_messages) > RECENT_MESSAGE_LIMIT:
                self._recent_messages.popitem(last=False)
        await self.handle_inbound(inbound)
        return inbound

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
        message = replace(
            message,
            text=_render_text(message),
            embeds=[],
            components=[],
        )
        return await super().send_message(
            source,
            message,
            reply_to=reply_to,
            session_key=session_key,
        )

    async def fetch_attachment(
        self,
        attachment: ChatAttachment,
        *,
        max_bytes: int | None = None,
    ) -> bytes:
        if attachment.data is not None:
            return await super().fetch_attachment(attachment, max_bytes=max_bytes)
        if not attachment.url or urlparse(attachment.url).scheme not in {"http", "https"}:
            return await super().fetch_attachment(attachment, max_bytes=max_bytes)
        limit = min(MAX_ATTACHMENT_BYTES, max_bytes) if max_bytes is not None else MAX_ATTACHMENT_BYTES
        if attachment.size > limit:
            raise ValueError("onebot.attachment.too_large")

        if self._http_session is None:
            self._http_session = aiohttp.ClientSession(
                connector=aiohttp.TCPConnector(
                    resolver=_PublicAddressResolver(),
                    use_dns_cache=False,
                ),
                timeout=aiohttp.ClientTimeout(total=self._attachment_timeout),
                trust_env=False,
            )
        try:
            async with asyncio.timeout(self._attachment_timeout):
                return await self._fetch_public_url(attachment.url, limit)
        except asyncio.CancelledError:
            raise
        except ValueError:
            raise
        except Exception as exc:
            logger.warning("onebot.attachment_fetch_failed error=%s", type(exc).__name__)
            raise FileNotFoundError(attachment.id or attachment.name) from None

    async def _fetch_public_url(self, url: str, limit: int) -> bytes:
        assert self._http_session is not None
        current_url = url
        for redirect_count in range(MAX_ATTACHMENT_REDIRECTS + 1):
            await _assert_public_http_url(current_url)
            async with self._http_session.get(
                current_url,
                allow_redirects=False,
            ) as response:
                if response.status in {
                    HTTPStatus.MOVED_PERMANENTLY,
                    HTTPStatus.FOUND,
                    HTTPStatus.SEE_OTHER,
                    HTTPStatus.TEMPORARY_REDIRECT,
                    HTTPStatus.PERMANENT_REDIRECT,
                }:
                    location = str(response.headers.get("Location") or "")
                    if not location or redirect_count >= MAX_ATTACHMENT_REDIRECTS:
                        raise ValueError("onebot.attachment.redirect.invalid")
                    current_url = urljoin(current_url, location)
                    continue

                response.raise_for_status()
                content_length = _integer(
                    response.headers.get("Content-Length"),
                    default=0,
                )
                if content_length > limit:
                    raise ValueError("onebot.attachment.too_large")
                chunks: list[bytes] = []
                size = 0
                async for chunk in response.content.iter_chunked(64 * 1024):
                    size += len(chunk)
                    if size > limit:
                        raise ValueError("onebot.attachment.too_large")
                    chunks.append(chunk)
                return b"".join(chunks)
        raise ValueError("onebot.attachment.redirect.invalid")

    async def _send_message(
        self,
        source: SessionSource,
        message: ChatMessage,
        *,
        reply_to: str | None,
        session_key: str | None,
    ) -> SendResult:
        del session_key
        if self._transport is None:
            return SendResult(ok=False, error="onebot.transport.unavailable")

        direct = source.chat_type.casefold() in _DIRECT_CHAT_TYPES
        if message.private and not direct and source.user_id is None:
            return SendResult(ok=False, error="onebot.private_target.unavailable")
        private_target = message.private and source.user_id is not None
        try:
            # A group message id is not valid in the private conversation used
            # for a private reply, so it must not become a reply segment there.
            segments = _outbound_segments(
                message,
                reply_to=None if private_target else reply_to,
            )
        except Exception as exc:
            logger.warning("onebot.message_encode_failed error=%s", type(exc).__name__)
            return SendResult(ok=False, error=_send_error(exc))
        if not segments:
            return SendResult(ok=False, error="onebot.message.empty")

        if direct or private_target:
            action = "send_private_msg"
            target = source.user_id if private_target else source.chat_id
            params: dict[str, Any] = {
                "user_id": _protocol_id(target),
                "message": segments,
            }
        else:
            action = "send_group_msg"
            params = {
                "group_id": _protocol_id(source.chat_id),
                "message": segments,
            }

        try:
            data = await _maybe_await(self._transport.call(action, params))
        except Exception as exc:
            logger.warning("onebot.send_failed error=%s", type(exc).__name__)
            return SendResult(ok=False, error=_send_error(exc))
        return SendResult(ok=True, message_id=_message_id(data))


def register() -> None:
    platform_registry.register(
        PlatformEntry(
            name="onebot",
            label="OneBot 11",
            adapter_factory=lambda cfg, context: OneBotAdapter(cfg),
            check_fn=lambda: True,
            # Forward mode (the default) dials this endpoint; reverse mode is
            # configured via TRPG_ONEBOT__LISTEN_HOST/PORT instead.
            required_env=["TRPG_ONEBOT__WS_URL"],
        )
    )


def _build_transport(config: Any) -> Any | None:
    mode = str(_config_value(config, "mode") or "").casefold()
    url = str(_config_value(config, "ws_url") or _config_value(config, "url") or "")
    if not mode:
        mode = "forward" if url else "reverse"
    access_token = str(
        _config_value(config, "access_token") or _config_value(config, "token") or ""
    )
    request_timeout = _float_value(
        _config_value(config, "request_timeout"),
        DEFAULT_REQUEST_TIMEOUT,
        allow_zero=False,
    )
    if request_timeout is None:
        return None

    if mode in {"forward", "client"}:
        if not _valid_ws_url(url):
            return None
        reconnect_delay = _float_value(
            _config_value(config, "reconnect_delay"),
            DEFAULT_RECONNECT_DELAY,
            allow_zero=True,
        )
        if reconnect_delay is None:
            return None
        return OneBotForwardWebSocketTransport(
            url,
            access_token=access_token,
            request_timeout=request_timeout,
            reconnect_delay=reconnect_delay,
        )
    if mode not in {"reverse", "server"}:
        return None

    port = _integer(
        _config_value(config, "listen_port") or _config_value(config, "port"),
        default=0,
    )
    if not 0 < port <= 65535:
        return None
    raw_host = _config_value(config, "listen_host")
    if raw_host is None:
        raw_host = _config_value(config, "host")
    host = "127.0.0.1" if raw_host is None else str(raw_host)
    if not host.strip():
        return None
    if not _is_loopback_host(host) and not access_token.strip():
        return None
    path = str(_config_value(config, "path") or DEFAULT_REVERSE_PATH)
    return OneBotReverseWebSocketTransport(
        host,
        port,
        path=path,
        access_token=access_token,
        request_timeout=request_timeout,
    )


def _decode_message(
    message: Any,
    self_id: str | None,
) -> tuple[str, bool, list[ChatAttachment]]:
    segments = message if isinstance(message, list) else _cq_segments(str(message or ""))
    text_parts: list[str] = []
    attachments: list[ChatAttachment] = []
    at_bot = False
    strip_next = False
    for item in segments:
        if not isinstance(item, dict):
            continue
        segment_type = str(item.get("type") or "").casefold()
        data = item.get("data") if isinstance(item.get("data"), dict) else {}
        if segment_type == "text":
            value = str(data.get("text") or "")
            if strip_next:
                value = value.lstrip()
                strip_next = False
            text_parts.append(value)
        elif segment_type == "at":
            target = _string_id(data.get("qq"))
            if self_id is not None and target == self_id:
                at_bot = True
                strip_next = True
            elif target:
                text_parts.append(f"@{target}")
        elif segment_type in _ATTACHMENT_TYPES:
            attachment = _attachment_from_segment(segment_type, data)
            if attachment is not None:
                attachments.append(attachment)
    return "".join(text_parts).strip(), at_bot, attachments


def _event_partition(payload: dict[str, Any]) -> str:
    self_id = str(payload.get("self_id") or "")
    post_type = str(payload.get("post_type") or "event").casefold()
    message_type = str(payload.get("message_type") or "").casefold()
    if post_type == "message" and message_type == "group":
        target = str(payload.get("group_id") or "")
    elif post_type == "message" and message_type == "private":
        target = str(payload.get("user_id") or "")
    else:
        target = str(payload.get("group_id") or payload.get("user_id") or "")
    return f"{self_id}:{post_type}:{message_type}:{target}"


def _cq_segments(message: str) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    position = 0
    for match in _CQ_CODE_RE.finditer(message):
        if match.start() > position:
            segments.append(
                {"type": "text", "data": {"text": _cq_unescape(message[position : match.start()])}}
            )
        data: dict[str, str] = {}
        for raw_parameter in (match.group(2) or "").split(","):
            if not raw_parameter:
                continue
            key, separator, value = raw_parameter.partition("=")
            if separator:
                data[key] = _cq_unescape(value)
        segments.append({"type": match.group(1), "data": data})
        position = match.end()
    if position < len(message):
        segments.append({"type": "text", "data": {"text": _cq_unescape(message[position:])}})
    return segments


def _cq_unescape(value: str) -> str:
    return (
        value.replace("&#44;", ",")
        .replace("&#91;", "[")
        .replace("&#93;", "]")
        .replace("&amp;", "&")
    )


def _attachment_from_segment(
    segment_type: str,
    data: dict[str, Any],
) -> ChatAttachment | None:
    file_value = str(data.get("file") or "")
    url_value = str(data.get("url") or "")
    url = url_value if urlparse(url_value).scheme in {"http", "https"} else None
    if url is None and urlparse(file_value).scheme in {"http", "https"}:
        url = file_value

    raw_data = None
    if file_value.startswith("base64://"):
        encoded = file_value.removeprefix("base64://")
        if len(encoded) > (MAX_ATTACHMENT_BYTES * 4 // 3) + 4:
            return None
        try:
            raw_data = base64.b64decode(encoded, validate=True)
        except ValueError:
            return None
        if len(raw_data) > MAX_ATTACHMENT_BYTES:
            return None

    name = str(data.get("name") or "") or _attachment_name(url or file_value, segment_type)
    mime = _attachment_mime(segment_type, name)
    size = _integer(data.get("file_size") or data.get("size"), default=0)
    return ChatAttachment(
        id=file_value or url_value or name,
        name=name,
        mime=mime,
        size=size if size >= 0 else 0,
        url=url,
        data=raw_data,
    )


def _outbound_segments(message: ChatMessage, *, reply_to: str | None) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    if reply_to:
        segments.append({"type": "reply", "data": {"id": reply_to}})

    text = _render_text(message)
    fallback: list[str] = []
    attachment_segments: list[dict[str, Any]] = []
    for attachment in message.attachments:
        segment = _outbound_attachment(attachment)
        if segment is not None:
            attachment_segments.append(segment)
        else:
            fallback.append(attachment.url or attachment.name)
    if fallback:
        text = "\n".join(part for part in (text, *fallback) if part)
    if text:
        segments.append({"type": "text", "data": {"text": text}})
    segments.extend(attachment_segments)
    return segments


def _render_text(message: ChatMessage) -> str:
    lines = [message.text] if message.text else []
    for embed in message.embeds:
        if embed.title:
            lines.append(embed.title)
        if embed.description:
            lines.append(embed.description)
        lines.extend(f"{field.name}: {field.value}" for field in embed.fields)
        if embed.footer:
            lines.append(embed.footer)
    lines.extend(
        f"{index}. {component.label or component.id} — {component.command}"
        for index, component in enumerate(message.components, 1)
        if component.command
    )
    return "\n".join(lines)


def _outbound_attachment(attachment: ChatAttachment) -> dict[str, Any] | None:
    mime = attachment.mime.casefold()
    if mime.startswith("image/"):
        segment_type = "image"
    elif mime.startswith("audio/"):
        segment_type = "record"
    elif mime.startswith("video/"):
        segment_type = "video"
    else:
        return None

    if attachment.data is not None:
        if len(attachment.data) > MAX_ATTACHMENT_BYTES:
            raise ValueError("onebot.attachment.too_large")
        file_value = f"base64://{base64.b64encode(attachment.data).decode('ascii')}"
    elif attachment.url and urlparse(attachment.url).scheme in {"http", "https"}:
        file_value = attachment.url
    else:
        return None
    return {"type": segment_type, "data": {"file": file_value}}


def _message_id(data: Any) -> str | None:
    if isinstance(data, dict) and isinstance(data.get("data"), dict):
        data = data["data"]
    value = data.get("message_id") if isinstance(data, dict) else None
    return _string_id(value)


def _send_error(exc: Exception) -> str:
    if isinstance(exc, OneBotAPIError):
        return f"onebot.api.{exc.retcode}"
    if isinstance(exc, TimeoutError):
        return "onebot.api.timeout"
    if isinstance(exc, ConnectionError):
        return "onebot.websocket.disconnected"
    return "onebot.send.failed"


def _sender_name(sender: dict[str, Any]) -> str | None:
    for key in ("card", "nickname"):
        value = sender.get(key)
        if value:
            return str(value)
    return None


def _attachment_name(value: str, segment_type: str) -> str:
    path = urlparse(value).path if value else ""
    name = PurePosixPath(path).name
    return name or segment_type


def _attachment_mime(segment_type: str, name: str) -> str:
    guessed = mimetypes.guess_type(name)[0]
    if guessed:
        return guessed
    return {
        "image": "image/jpeg",
        "record": "audio/ogg",
        "video": "video/mp4",
        "file": "application/octet-stream",
    }[segment_type]


def _json_object(raw: Any) -> dict[str, Any] | None:
    if isinstance(raw, bytes):
        try:
            raw = raw.decode("utf-8")
        except UnicodeDecodeError:
            return None
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return None
    return raw if isinstance(raw, dict) else None


def _protocol_id(value: Any) -> int | str:
    text = str(value or "")
    try:
        return int(text)
    except ValueError:
        return text


def _integer(value: Any, *, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _float_value(value: Any, default: float, *, allow_zero: bool) -> float | None:
    if value is None or value == "":
        return default
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    minimum_valid = result >= 0 if allow_zero else result > 0
    return result if math.isfinite(result) and minimum_valid else None


def _valid_ws_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
        _ = parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme.casefold() in {"ws", "wss"}
        and bool(parsed.hostname)
        and not parsed.fragment
        and not any(character.isspace() for character in parsed.hostname or "")
    )


def _is_loopback_host(value: str) -> bool:
    host = value.strip().casefold().rstrip(".")
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


async def _assert_public_http_url(value: str) -> None:
    try:
        parsed = urlparse(value)
        port = parsed.port or (443 if parsed.scheme.casefold() == "https" else 80)
    except ValueError as exc:
        raise ValueError("onebot.attachment.unsafe_url") from exc
    host = parsed.hostname or ""
    if (
        parsed.scheme.casefold() not in {"http", "https"}
        or not host
        or parsed.username is not None
        or parsed.password is not None
        or bool(parsed.fragment)
        or any(character.isspace() for character in host)
    ):
        raise ValueError("onebot.attachment.unsafe_url")

    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        addresses = await _resolve_addresses(host, port)
        if not addresses or any(not _is_public_ip(address) for address in addresses):
            raise ValueError("onebot.attachment.unsafe_url") from None
    else:
        if not _is_public_ip(str(literal)):
            raise ValueError("onebot.attachment.unsafe_url")


async def _resolve_addresses(host: str, port: int) -> set[str]:
    loop = asyncio.get_running_loop()
    results = await loop.getaddrinfo(
        host,
        port,
        type=socket.SOCK_STREAM,
    )
    return {str(sockaddr[0]) for _family, _type, _proto, _canonname, sockaddr in results}


def _is_public_ip(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    mapped = getattr(address, "ipv4_mapped", None)
    if mapped is not None:
        address = mapped
    return bool(
        address.is_global
        and not address.is_private
        and not address.is_loopback
        and not address.is_link_local
        and not address.is_multicast
        and not address.is_reserved
        and not address.is_unspecified
    )


def _string_id(value: Any) -> str | None:
    return None if value is None else str(value)


def _normalize_path(value: str) -> str:
    path = value or DEFAULT_REVERSE_PATH
    return path if path.startswith("/") else f"/{path}"


def _config_value(config: Any, key: str) -> Any:
    if isinstance(config, dict):
        return config.get(key)
    return getattr(config, key, None)


async def _maybe_await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


register()
