"""Feishu/Lark gateway adapter.

Originally trimmed from the Hermes Feishu adapter design (MIT, Copyright 2025
Nous Research); the structured gateway and stoppable long connection are native
to Loreweaver.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import http
import inspect
import io
import json
import logging
import mimetypes
import threading
from collections import OrderedDict
from dataclasses import replace
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx

from gateway.base_adapter import BaseAdapter, MessageHandler
from gateway.chat import ChatAttachment, ChatCapabilities, ChatMessage
from gateway.events import InboundMessage, SendResult
from gateway.registry import PlatformEntry, platform_registry
from gateway.session import SessionSource
from infra.i18n import t as localize

try:  # pragma: no cover - optional runtime dependency
    import lark_oapi as lark
    from lark_oapi.api.im.v1 import (
        CreateFileRequest,
        CreateFileRequestBody,
        CreateImageRequest,
        CreateImageRequestBody,
        CreateMessageRequest,
        CreateMessageRequestBody,
        GetMessageRequest,
        GetMessageResourceRequest,
        ReplyMessageRequest,
        ReplyMessageRequestBody,
    )
    from lark_oapi.core.enum import AccessTokenType, HttpMethod
    from lark_oapi.core.model import BaseRequest
    from lark_oapi.ws import client as lark_ws_module

    LARK_OAPI_AVAILABLE = True
except ImportError:  # pragma: no cover - importability without the Feishu extra
    lark = None  # type: ignore[assignment]
    CreateFileRequest = None  # type: ignore[assignment]
    CreateFileRequestBody = None  # type: ignore[assignment]
    CreateImageRequest = None  # type: ignore[assignment]
    CreateImageRequestBody = None  # type: ignore[assignment]
    CreateMessageRequest = None  # type: ignore[assignment]
    CreateMessageRequestBody = None  # type: ignore[assignment]
    GetMessageRequest = None  # type: ignore[assignment]
    GetMessageResourceRequest = None  # type: ignore[assignment]
    ReplyMessageRequest = None  # type: ignore[assignment]
    ReplyMessageRequestBody = None  # type: ignore[assignment]
    AccessTokenType = None  # type: ignore[assignment]
    HttpMethod = None  # type: ignore[assignment]
    BaseRequest = None  # type: ignore[assignment]
    lark_ws_module = None  # type: ignore[assignment]
    LARK_OAPI_AVAILABLE = False


logger = logging.getLogger(__name__)

MESSAGE_EVENT = "im.message.receive_v1"
MAX_TEXT_CHARS = 4000
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_FILE_BYTES = 30 * 1024 * 1024
RECENT_MESSAGE_IDS = 2048
RESOURCE_CACHE_ITEMS = 2048
_BOT_SENDER_TYPES = {"app", "bot"}
WS_ENDPOINT_TIMEOUT = 10.0
WS_CONNECT_TIMEOUT = 10.0
WS_CLOSE_TIMEOUT = 3.0
WS_START_TIMEOUT = 25.0
WS_STOP_TIMEOUT = 5.0
WS_RETRY_DELAY = 1.0
SDK_CALLBACK_TIMEOUT = 2.0
INBOUND_DRAIN_TIMEOUT = 1.0


class _RecentIds:
    """Bounded duplicate window for Feishu's timeout/reconnect redelivery."""

    def __init__(self, maximum: int = RECENT_MESSAGE_IDS) -> None:
        self._maximum = maximum
        self._items: OrderedDict[str, None] = OrderedDict()

    def add(self, value: str) -> bool:
        if value in self._items:
            self._items.move_to_end(value)
            return False
        self._items[value] = None
        while len(self._items) > self._maximum:
            self._items.popitem(last=False)
        return True


class _LarkMessageTransport:
    """Small async facade over lark-oapi's synchronous generated resources."""

    def __init__(self, client: Any) -> None:
        self._client = client
        self.im = SimpleNamespace(v1=SimpleNamespace(message=SimpleNamespace(create=self.create, reply=self.reply)))

    async def create(
        self,
        *,
        receive_id: str,
        receive_id_type: str,
        msg_type: str,
        content: str,
    ) -> Any:
        if CreateMessageRequest is None or CreateMessageRequestBody is None:
            return None
        body = (
            CreateMessageRequestBody.builder()
            .receive_id(receive_id)
            .msg_type(msg_type)
            .content(content)
            .build()
        )
        request = (
            CreateMessageRequest.builder()
            .receive_id_type(receive_id_type)
            .request_body(body)
            .build()
        )
        return await asyncio.to_thread(self._client.im.v1.message.create, request)

    async def reply(self, *, message_id: str, msg_type: str, content: str) -> Any:
        if ReplyMessageRequest is None or ReplyMessageRequestBody is None:
            return None
        body = ReplyMessageRequestBody.builder().msg_type(msg_type).content(content).build()
        request = ReplyMessageRequest.builder().message_id(message_id).request_body(body).build()
        return await asyncio.to_thread(self._client.im.v1.message.reply, request)

    async def upload_image(self, *, data: bytes) -> Any:
        if CreateImageRequest is None or CreateImageRequestBody is None:
            return None
        body = CreateImageRequestBody.builder().image_type("message").image(io.BytesIO(data)).build()
        request = CreateImageRequest.builder().request_body(body).build()
        return await asyncio.to_thread(self._client.im.v1.image.create, request)

    async def upload_file(self, *, data: bytes, name: str) -> Any:
        if CreateFileRequest is None or CreateFileRequestBody is None:
            return None
        body = (
            CreateFileRequestBody.builder()
            .file_type("stream")
            .file_name(name)
            .file(io.BytesIO(data))
            .build()
        )
        request = CreateFileRequest.builder().request_body(body).build()
        return await asyncio.to_thread(self._client.im.v1.file.create, request)

    async def fetch_resource(self, *, message_id: str, file_key: str, resource_type: str) -> bytes:
        if GetMessageResourceRequest is None:
            raise FileNotFoundError(file_key)
        request = (
            GetMessageResourceRequest.builder()
            .message_id(message_id)
            .file_key(file_key)
            .type(resource_type)
            .build()
        )
        response = await asyncio.to_thread(self._client.im.v1.message_resource.get, request)
        if not _response_success(response):
            raise FileNotFoundError(file_key)
        file_obj = getattr(response, "file", None)
        if file_obj is None:
            raise FileNotFoundError(file_key)
        if hasattr(file_obj, "getvalue"):
            return bytes(file_obj.getvalue())
        return bytes(file_obj.read())

    async def get_message_text(self, message_id: str) -> str:
        if GetMessageRequest is None:
            return ""
        request = GetMessageRequest.builder().message_id(message_id).build()
        response = await asyncio.to_thread(self._client.im.v1.message.get, request)
        if not _response_success(response):
            return ""
        items = getattr(getattr(response, "data", None), "items", None) or []
        if not items:
            return ""
        message = items[0]
        body = getattr(message, "body", None)
        raw_content = getattr(body, "content", "") if body is not None else ""
        return _content_text(str(getattr(message, "msg_type", "") or ""), raw_content)

    async def bot_open_id(self) -> str:
        if BaseRequest is None or HttpMethod is None or AccessTokenType is None:
            return ""
        request = (
            BaseRequest.builder()
            .http_method(HttpMethod.GET)
            .uri("/open-apis/bot/v3/info")
            .token_types({AccessTokenType.TENANT})
            .build()
        )
        response = await asyncio.to_thread(self._client.request, request)
        if not _response_success(response):
            return ""
        raw = getattr(getattr(response, "raw", None), "content", b"")
        payload = _json_object(raw)
        bot = payload.get("bot")
        return str(bot.get("open_id") or "") if isinstance(bot, dict) else ""


_LarkWsBase = lark.ws.Client if LARK_OAPI_AVAILABLE and lark is not None else object


class _ControlledLarkWsClient(_LarkWsBase):
    """lark-oapi 1.5.5 client whose work stays on the current event loop.

    The upstream client performs a blocking endpoint request and schedules work
    on a module-global loop. This subclass keeps its wire format and dispatcher,
    but owns endpoint, connection, receive-task, and close lifecycles explicitly.
    """

    def __init__(
        self,
        *args: Any,
        endpoint_timeout: float = WS_ENDPOINT_TIMEOUT,
        connect_timeout: float = WS_CONNECT_TIMEOUT,
        close_timeout: float = WS_CLOSE_TIMEOUT,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._endpoint_timeout = endpoint_timeout
        self._connect_timeout = connect_timeout
        self._close_timeout = close_timeout
        self._receive_task: asyncio.Task[Any] | None = None
        self._message_tasks: set[asyncio.Task[Any]] = set()

    async def connect(self) -> asyncio.Task[Any]:
        """Connect once and return the receive task for external supervision."""
        connection: Any | None = None
        async with self._lock:
            if self._conn is not None and self._receive_task is not None:
                return self._receive_task
            try:
                conn_url = await self._get_conn_url_async()
                parsed = urlparse(conn_url)
                query = parse_qs(parsed.query)
                conn_id = query[lark_ws_module.DEVICE_ID][0]
                service_id = query[lark_ws_module.SERVICE_ID][0]
                connection = await asyncio.wait_for(
                    lark_ws_module.websockets.connect(
                        conn_url,
                        open_timeout=self._connect_timeout,
                        close_timeout=self._close_timeout,
                    ),
                    timeout=self._connect_timeout,
                )
                self._conn = connection
                self._conn_url = conn_url
                self._conn_id = conn_id
                self._service_id = service_id
                self._receive_task = asyncio.get_running_loop().create_task(
                    self._receive_messages()
                )
                return self._receive_task
            except BaseException:
                if connection is not None:
                    with contextlib.suppress(BaseException):
                        await asyncio.wait_for(
                            connection.close(),
                            timeout=self._close_timeout,
                        )
                self._clear_connection()
                raise

    async def ping_loop(self) -> None:
        await self._ping_loop()

    async def disconnect(self) -> None:
        receive_task = self._receive_task
        self._receive_task = None
        if receive_task is not None and receive_task is not asyncio.current_task():
            receive_task.cancel()
            await asyncio.gather(receive_task, return_exceptions=True)
        message_tasks = list(self._message_tasks)
        for task in message_tasks:
            task.cancel()
        if message_tasks:
            await asyncio.gather(*message_tasks, return_exceptions=True)
        async with self._lock:
            connection = self._conn
            self._clear_connection()
            if connection is not None:
                await asyncio.wait_for(
                    connection.close(),
                    timeout=self._close_timeout,
                )

    async def _get_conn_url_async(self) -> str:
        if not self._app_id or not self._app_secret:
            raise lark_ws_module.ClientException(
                lark_ws_module.NO_CREDENTIAL,
                "feishu.credentials.missing",
            )
        timeout = httpx.Timeout(self._endpoint_timeout)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                self._domain + lark_ws_module.GEN_ENDPOINT_URI,
                headers={"locale": "zh"},
                json={"AppID": self._app_id, "AppSecret": self._app_secret},
            )
        if response.status_code != http.HTTPStatus.OK:
            raise lark_ws_module.ServerException(
                response.status_code,
                "feishu.websocket.system_busy",
            )
        endpoint = lark_ws_module.JSON.unmarshal(
            response.text,
            lark_ws_module.EndpointResp,
        )
        if endpoint.code == lark_ws_module.OK:
            pass
        elif endpoint.code == lark_ws_module.SYSTEM_BUSY:
            raise lark_ws_module.ServerException(
                endpoint.code,
                "feishu.websocket.system_busy",
            )
        elif endpoint.code == lark_ws_module.INTERNAL_ERROR:
            raise lark_ws_module.ServerException(endpoint.code, endpoint.msg)
        else:
            raise lark_ws_module.ClientException(endpoint.code, endpoint.msg)
        if endpoint.data is None or not endpoint.data.URL:
            raise lark_ws_module.ServerException(
                lark_ws_module.INTERNAL_ERROR,
                "feishu.websocket.endpoint_url.missing",
            )
        if endpoint.data.ClientConfig is not None:
            self._configure(endpoint.data.ClientConfig)
        return str(endpoint.data.URL)

    async def _receive_messages(self) -> None:
        while True:
            connection = self._conn
            if connection is None:
                raise lark_ws_module.ConnectionClosedException(
                    "feishu.websocket.connection.closed"
                )
            message = await connection.recv()
            task = asyncio.get_running_loop().create_task(self._handle_message(message))
            self._message_tasks.add(task)
            task.add_done_callback(self._message_done)

    def _message_done(self, task: asyncio.Task[Any]) -> None:
        self._message_tasks.discard(task)
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            logger.error("feishu.websocket_message_failed error=%s", type(error).__name__)

    def _clear_connection(self) -> None:
        self._conn = None
        self._conn_url = ""
        self._conn_id = ""
        self._service_id = ""


class _LarkEventSource:
    """Supervise a stoppable lark WebSocket client on an isolated event loop."""

    def __init__(
        self,
        client_or_factory: Any,
        *,
        permanent_exceptions: tuple[type[BaseException], ...] = (),
        retry_delay: float = WS_RETRY_DELAY,
        start_timeout: float = WS_START_TIMEOUT,
        stop_timeout: float = WS_STOP_TIMEOUT,
    ) -> None:
        self._client_factory = (
            client_or_factory if callable(client_or_factory) else lambda: client_or_factory
        )
        self._permanent_exceptions = permanent_exceptions
        self._retry_delay = retry_delay
        self._start_timeout = start_timeout
        self._stop_timeout = stop_timeout
        self._client: Any | None = None
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._runner_task: asyncio.Task[Any] | None = None
        self._stop_event: asyncio.Event | None = None
        self._stop_requested = threading.Event()
        self._started = threading.Event()
        self._start_result = False
        self.error: BaseException | None = None

    def start(self) -> bool:
        thread = self._thread
        if thread is not None and thread.is_alive():
            self._started.wait(timeout=self._start_timeout)
            return self._start_result
        if thread is not None:
            thread.join(timeout=0)
        self._stop_requested.clear()
        self._started.clear()
        self._start_result = False
        self.error = None
        self._thread = threading.Thread(
            target=self._run,
            name="loreweaver-feishu-ws",
            daemon=True,
        )
        self._thread.start()
        if not self._started.wait(timeout=self._start_timeout):
            self.stop()
            return False
        if not self._start_result:
            self.stop()
        return self._start_result

    def stop(self) -> None:
        already_stopping = self._stop_requested.is_set()
        self._stop_requested.set()
        loop = self._loop
        runner_task = self._runner_task
        if loop is not None and loop.is_running():
            try:
                if self._stop_event is not None:
                    loop.call_soon_threadsafe(self._stop_event.set)
                if runner_task is not None and not already_stopping:
                    loop.call_soon_threadsafe(runner_task.cancel)
            except RuntimeError:
                # The owned loop can close between is_running() and submission.
                pass
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=self._stop_timeout)
            if thread.is_alive():
                logger.error("feishu.websocket_stop_timeout")

    def _run(self) -> None:
        loop = asyncio.new_event_loop()
        self._loop = loop
        self._stop_event = asyncio.Event()
        self._runner_task = loop.create_task(self._serve())
        try:
            loop.run_until_complete(self._runner_task)
        except asyncio.CancelledError:
            pass
        except BaseException as exc:
            self.error = exc
            if not self._stop_requested.is_set():
                logger.error("feishu.websocket_failed error=%s", type(exc).__name__)
        finally:
            if not self._started.is_set():
                self._signal_started(False)
            pending = [task for task in asyncio.all_tasks(loop) if not task.done()]
            for task in pending:
                task.cancel()
            if pending:
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            loop.close()
            self._runner_task = None
            self._stop_event = None
            self._loop = None

    async def _serve(self) -> None:
        assert self._stop_event is not None
        while not self._stop_requested.is_set():
            client = self._client_factory()
            self._client = client
            receive_task: asyncio.Task[Any] | None = None
            ping_task: asyncio.Task[Any] | None = None
            stop_task: asyncio.Task[Any] | None = None
            try:
                receive_task = await client.connect()
                if not isinstance(receive_task, asyncio.Task):
                    raise RuntimeError("feishu.websocket.receive_task.missing")
                if receive_task.done():
                    receive_task.result()
                    raise RuntimeError("feishu.websocket.receive_task.startup_exit")
                ping_task = asyncio.create_task(client.ping_loop())
                self._signal_started(True)
                stop_task = asyncio.create_task(self._stop_event.wait())
                done, _ = await asyncio.wait(
                    {receive_task, stop_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if stop_task in done or self._stop_requested.is_set():
                    return
                receive_task.result()
                raise RuntimeError("feishu.websocket.receive_task.exit")
            except asyncio.CancelledError:
                raise
            except self._permanent_exceptions as exc:
                self.error = exc
                self._signal_started(False)
                return
            except Exception as exc:
                self.error = exc
                if self._started.is_set():
                    logger.warning(
                        "feishu.websocket_reconnect error=%s",
                        type(exc).__name__,
                    )
            finally:
                for task in (stop_task, ping_task, receive_task):
                    if task is not None and not task.done():
                        task.cancel()
                tasks = [
                    task
                    for task in (stop_task, ping_task, receive_task)
                    if task is not None
                ]
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)
                with contextlib.suppress(Exception):
                    await client.disconnect()
            if self._stop_requested.is_set():
                return
            try:
                await asyncio.wait_for(
                    self._stop_event.wait(),
                    timeout=self._retry_delay,
                )
            except TimeoutError:
                continue

    def _signal_started(self, result: bool) -> None:
        if self._started.is_set():
            return
        self._start_result = result
        self._started.set()


def _config_value(config: Any, key: str) -> str:
    if isinstance(config, dict):
        value = config.get(key)
    else:
        value = getattr(config, key, None)
    return str(value or "")


def _config_float(config: Any, key: str, default: float) -> float:
    if isinstance(config, dict):
        value = config.get(key, default)
    else:
        value = getattr(config, key, default)
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _build_transport(config: Any) -> Any | None:
    if not LARK_OAPI_AVAILABLE or lark is None:
        return None
    app_id = _config_value(config, "app_id")
    app_secret = _config_value(config, "app_secret")
    if not app_id or not app_secret:
        return None
    client = lark.Client.builder().app_id(app_id).app_secret(app_secret).timeout(10).build()
    return _LarkMessageTransport(client)


def _build_event_source(config: Any, callback: Any) -> _LarkEventSource | None:
    if not LARK_OAPI_AVAILABLE or lark is None or lark_ws_module is None:
        return None
    app_id = _config_value(config, "app_id")
    app_secret = _config_value(config, "app_secret")
    if not app_id or not app_secret:
        return None
    event_handler = (
        lark.EventDispatcherHandler.builder("", "")
        .register_p2_im_message_receive_v1(callback)
        .build()
    )
    endpoint_timeout = _config_float(
        config,
        "ws_endpoint_timeout",
        WS_ENDPOINT_TIMEOUT,
    )
    connect_timeout = _config_float(config, "ws_connect_timeout", WS_CONNECT_TIMEOUT)
    close_timeout = _config_float(config, "ws_close_timeout", WS_CLOSE_TIMEOUT)

    def client_factory() -> _ControlledLarkWsClient:
        return _ControlledLarkWsClient(
            app_id,
            app_secret,
            event_handler=event_handler,
            log_level=lark.LogLevel.INFO,
            auto_reconnect=False,
            endpoint_timeout=endpoint_timeout,
            connect_timeout=connect_timeout,
            close_timeout=close_timeout,
        )

    return _LarkEventSource(
        client_factory,
        permanent_exceptions=(lark_ws_module.ClientException,),
        retry_delay=_config_float(config, "ws_retry_delay", WS_RETRY_DELAY),
        start_timeout=_config_float(config, "ws_start_timeout", WS_START_TIMEOUT),
        stop_timeout=_config_float(config, "ws_stop_timeout", WS_STOP_TIMEOUT),
    )


def _event_payload(event: dict[str, Any]) -> dict[str, Any]:
    payload = event.get("event")
    return payload if isinstance(payload, dict) else event


def _message_payload(event: dict[str, Any]) -> dict[str, Any]:
    payload = _event_payload(event).get("message")
    return payload if isinstance(payload, dict) else {}


def _sender_payload(event: dict[str, Any]) -> dict[str, Any]:
    sender = _event_payload(event).get("sender")
    return sender if isinstance(sender, dict) else {}


def _sender_open_id(event: dict[str, Any]) -> str | None:
    sender_id = _sender_payload(event).get("sender_id")
    if not isinstance(sender_id, dict):
        return None
    for key in ("open_id", "user_id", "union_id"):
        value = sender_id.get(key)
        if value:
            return str(value)
    return None


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    try:
        parsed = json.loads(str(value))
    except (TypeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _content_text(message_type: str, raw_content: Any) -> str:
    payload = _json_object(raw_content)
    if message_type == "text":
        return str(payload.get("text") or "")
    if message_type != "post":
        return ""
    post = _post_payload(payload)
    lines: list[str] = []
    title = str(post.get("title") or "").strip()
    if title:
        lines.append(title)
    paragraphs = post.get("content")
    if isinstance(paragraphs, list):
        for paragraph in paragraphs:
            if not isinstance(paragraph, list):
                continue
            text = "".join(_post_element_text(item) for item in paragraph if isinstance(item, dict)).strip()
            if text:
                lines.append(text)
    return "\n".join(lines)


def _post_payload(payload: dict[str, Any]) -> dict[str, Any]:
    if isinstance(payload.get("content"), list):
        return payload
    for locale in ("zh_cn", "en_us", "ja_jp"):
        value = payload.get(locale)
        if isinstance(value, dict):
            return value
    return next((value for value in payload.values() if isinstance(value, dict)), {})


def _post_element_text(element: dict[str, Any]) -> str:
    tag = str(element.get("tag") or "")
    if tag in {"text", "a"}:
        return str(element.get("text") or "")
    if tag == "at":
        return f"@{element.get('user_name') or element.get('user_id') or ''}"
    if tag == "emotion":
        return str(element.get("emoji_type") or "")
    return ""


def _mentions(message: dict[str, Any]) -> list[dict[str, Any]]:
    value = message.get("mentions")
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _mention_open_id(mention: dict[str, Any]) -> str:
    identity = mention.get("id")
    if not isinstance(identity, dict):
        return ""
    return str(identity.get("open_id") or identity.get("user_id") or "")


def _replace_mentions(text: str, mentions: list[dict[str, Any]], bot_open_id: str) -> tuple[str, bool]:
    at_bot = False
    # Longest keys first: "@_user_1" is a prefix of "@_user_10", so replacing
    # the short key first would corrupt the longer placeholder.
    ordered = sorted(mentions, key=lambda item: len(str(item.get("key") or "")), reverse=True)
    for mention in ordered:
        key = str(mention.get("key") or "")
        if not key:
            continue
        is_bot = bool(bot_open_id and _mention_open_id(mention) == bot_open_id)
        at_bot = at_bot or is_bot
        replacement = "" if is_bot else f"@{mention.get('name') or _mention_open_id(mention)}"
        text = text.replace(key, replacement)
        if is_bot and mention.get("name"):
            text = text.replace(f"@{mention['name']}", "")
    return text.strip(), at_bot


def _receive_id_type_for(identifier: str) -> str:
    """Map a Feishu identifier to its receive_id_type by documented prefix."""
    if identifier.startswith("ou_"):
        return "open_id"
    if identifier.startswith("on_"):
        return "union_id"
    return "user_id"


def _extract_message_id(response: Any) -> str | None:
    if response is None:
        return None
    if isinstance(response, dict):
        data = response.get("data")
        if isinstance(data, dict) and data.get("message_id"):
            return str(data["message_id"])
        value = response.get("message_id")
        return str(value) if value else None
    data = getattr(response, "data", None)
    value = getattr(data, "message_id", None) if data is not None else None
    if value is None:
        value = getattr(response, "message_id", None)
    return str(value) if value else None


def _extract_resource_key(response: Any, key: str) -> str:
    if isinstance(response, dict):
        data = response.get("data")
        value = data.get(key) if isinstance(data, dict) else response.get(key)
    else:
        data = getattr(response, "data", None)
        value = getattr(data, key, None) if data is not None else getattr(response, key, None)
    return str(value or "")


def _response_success(response: Any) -> bool:
    if response is None:
        return False
    success = getattr(response, "success", None)
    if callable(success):
        return bool(success())
    if isinstance(response, dict):
        if "ok" in response:
            return bool(response["ok"])
        if "code" in response:
            return response["code"] in {0, "0", None}
    return True


def _render_text(message: ChatMessage) -> str:
    lines = [message.text] if message.text else []
    for embed in message.embeds:
        lines.extend(item for item in (embed.title, embed.description) if item)
        lines.extend(f"{field.name}: {field.value}" for field in embed.fields)
        if embed.footer:
            lines.append(embed.footer)
    components = [item for item in message.components if item.command]
    lines.extend(
        f"{index}. {component.label or component.id} — {component.command}"
        for index, component in enumerate(components, 1)
    )
    return "\n".join(lines)


async def _call(method: Any, /, *args: Any, **kwargs: Any) -> Any:
    if inspect.iscoroutinefunction(method):
        return await method(*args, **kwargs)
    result = await asyncio.to_thread(method, *args, **kwargs)
    return await result if inspect.isawaitable(result) else result


class FeishuAdapter(BaseAdapter):
    platform = "feishu"
    capabilities = ChatCapabilities(attachments=True, max_text_chars=MAX_TEXT_CHARS)

    def __init__(
        self,
        config: Any = None,
        on_message: MessageHandler | None = None,
        transport: Any | None = None,
        *,
        event_source: Any | None = None,
    ) -> None:
        if transport is None and on_message is not None and not callable(on_message):
            transport = on_message
            on_message = None
        super().__init__(config=config, on_message=on_message)
        self._transport = transport if transport is not None else _build_transport(config)
        self._event_source = event_source
        self._main_loop: asyncio.AbstractEventLoop | None = None
        self._bot_open_id = _config_value(config, "bot_open_id").strip()
        self._recent_ids = _RecentIds()
        self._resources: OrderedDict[str, tuple[str, str, str]] = OrderedDict()
        self._tasks: set[asyncio.Task[Any]] = set()
        self._sdk_futures: set[concurrent.futures.Future[Any]] = set()
        self._sdk_futures_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._accepting_events = False
        self._callback_timeout = _config_float(
            config,
            "callback_timeout",
            SDK_CALLBACK_TIMEOUT,
        )
        self._drain_timeout = _config_float(
            config,
            "inbound_drain_timeout",
            INBOUND_DRAIN_TIMEOUT,
        )

    async def connect(self) -> bool:
        if self._transport is None:
            return False
        self._main_loop = asyncio.get_running_loop()
        if not self._bot_open_id:
            resolver = getattr(self._transport, "bot_open_id", None)
            if callable(resolver):
                try:
                    self._bot_open_id = str(await _call(resolver) or "").strip()
                except Exception as exc:
                    logger.warning("feishu.bot_identity_failed error=%s", type(exc).__name__)
        if not self._bot_open_id:
            logger.warning("feishu.bot_identity_missing")
            self._main_loop = None
            return False
        if self._event_source is None:
            self._event_source = _build_event_source(self.config, self._on_sdk_event)
        if self._event_source is None:
            self._main_loop = None
            return False
        starter = getattr(self._event_source, "start", None)
        if not callable(starter):
            self._main_loop = None
            return False
        self._set_accepting_events(True)
        try:
            connected = bool(
                await _call(starter, self._on_sdk_event)
                if _accepts_argument(starter)
                else await _call(starter)
            )
        except asyncio.CancelledError:
            self._set_accepting_events(False)
            await self._stop_event_source()
            self._main_loop = None
            raise
        except Exception as exc:
            logger.warning("feishu.websocket_start_failed error=%s", type(exc).__name__)
            connected = False
        if not connected:
            self._set_accepting_events(False)
            await self._stop_event_source()
            self._main_loop = None
        return connected

    async def disconnect(self) -> None:
        self._set_accepting_events(False)
        await self._stop_event_source()
        with self._sdk_futures_lock:
            futures = list(self._sdk_futures)
        for future in futures:
            if not future.done():
                future.cancel()
        tasks = list(self._tasks)
        if tasks:
            _, pending = await asyncio.wait(tasks, timeout=self._drain_timeout)
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
        closer = getattr(self._transport, "aclose", None) or getattr(self._transport, "close", None)
        if callable(closer):
            try:
                await _call(closer)
            except Exception as exc:
                logger.warning("feishu.transport_close_failed error=%s", type(exc).__name__)
        self._resources.clear()
        self._main_loop = None

    async def _stop_event_source(self) -> None:
        source = self._event_source
        if source is None:
            return
        stopper = getattr(source, "stop", None) or getattr(source, "close", None)
        if callable(stopper):
            try:
                await _call(stopper)
            except Exception as exc:
                logger.warning("feishu.websocket_stop_failed error=%s", type(exc).__name__)

    def _set_accepting_events(self, accepting: bool) -> None:
        with self._state_lock:
            self._accepting_events = accepting

    def supports_private_reply(self, source: SessionSource) -> bool:
        return bool(source.user_id)

    def to_inbound_message(self, event: dict[str, Any]) -> InboundMessage | None:
        message = _message_payload(event)
        message_id = str(message.get("message_id") or "")
        chat_id = str(message.get("chat_id") or "")
        if not message_id or not chat_id:
            return None
        raw_chat_type = str(message.get("chat_type") or "").casefold()
        chat_type = "group" if raw_chat_type != "p2p" else "dm"
        message_type = str(message.get("message_type") or "")
        mentions = _mentions(message)
        text, at_bot = _replace_mentions(
            _content_text(message_type, message.get("content")),
            mentions,
            self._bot_open_id,
        )
        attachments = self._attachments_from(message_id, message_type, message.get("content"))
        sender = _sender_payload(event)
        sender_type = str(sender.get("sender_type") or "").casefold()
        user_name = sender.get("name") or sender.get("sender_name")
        source = SessionSource(
            platform=self.platform,
            chat_type=chat_type,
            chat_id=chat_id,
            user_id=_sender_open_id(event),
            user_name=str(user_name) if user_name else None,
            thread_id=str(message.get("thread_id") or "") or None,
            message_id=message_id,
            is_bot=sender_type in _BOT_SENDER_TYPES,
        )
        return InboundMessage(
            source=source,
            text=text,
            at_bot=at_bot,
            attachments=attachments,
            raw=event,
        )

    async def handle_event(self, event: dict[str, Any]) -> InboundMessage | None:
        """Acknowledge quickly by queueing the Keeper turn on the gateway loop."""
        header = event.get("header")
        event_type = header.get("event_type") if isinstance(header, dict) else None
        if event_type and event_type != MESSAGE_EVENT:
            return None
        inbound = self.to_inbound_message(event)
        if inbound is None or not self._recent_ids.add(inbound.source.message_id or ""):
            return None
        parent_id = str(_message_payload(event).get("parent_id") or "")
        task = asyncio.create_task(self._process_inbound(inbound, parent_id))
        self._tasks.add(task)
        task.add_done_callback(self._task_done)
        return inbound

    async def wait_idle(self) -> None:
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    async def _process_inbound(self, inbound: InboundMessage, parent_id: str) -> None:
        if parent_id:
            getter = getattr(self._transport, "get_message_text", None)
            if callable(getter):
                try:
                    inbound.quoted_text = str(await _call(getter, parent_id) or "")
                except Exception as exc:
                    logger.warning("feishu.quote_fetch_failed error=%s", type(exc).__name__)
        await self.handle_inbound(inbound)

    def _task_done(self, task: asyncio.Task[Any]) -> None:
        self._tasks.discard(task)
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            logger.error("feishu.inbound_failed error=%s", type(error).__name__)

    def _on_sdk_event(self, data: Any) -> InboundMessage | None:
        event = self._sdk_event_dict(data)
        if event is None:
            raise ValueError("feishu.event.invalid")
        with self._state_lock:
            loop = self._main_loop
            accepting = self._accepting_events
        if not accepting or loop is None or loop.is_closed() or not loop.is_running():
            raise RuntimeError("feishu.events.not_accepting")
        coroutine = self.handle_event(event)
        try:
            future = asyncio.run_coroutine_threadsafe(coroutine, loop)
        except Exception:
            coroutine.close()
            raise RuntimeError("feishu.events.loop_rejected") from None
        with self._sdk_futures_lock:
            self._sdk_futures.add(future)
        try:
            return future.result(timeout=self._callback_timeout)
        except concurrent.futures.TimeoutError:
            future.cancel()
            raise TimeoutError("feishu.events.acceptance_timeout") from None
        except concurrent.futures.CancelledError:
            raise RuntimeError("feishu.events.acceptance_cancelled") from None
        except Exception as exc:
            raise RuntimeError("feishu.events.acceptance_failed") from exc
        finally:
            with self._sdk_futures_lock:
                self._sdk_futures.discard(future)

    def _sdk_event_dict(self, data: Any) -> dict[str, Any] | None:
        if isinstance(data, dict):
            return data
        if lark is None:
            return None
        try:
            value = json.loads(lark.JSON.marshal(data))
        except (TypeError, ValueError, json.JSONDecodeError):
            logger.warning("feishu.event_decode_failed")
            return None
        return value if isinstance(value, dict) else None

    def _attachments_from(
        self,
        message_id: str,
        message_type: str,
        raw_content: Any,
    ) -> list[ChatAttachment]:
        payload = _json_object(raw_content)
        specs: list[tuple[str, str, str, str]] = []
        if message_type == "image":
            key = str(payload.get("image_key") or "")
            specs.append((key, f"{message_id}.jpg", "image/jpeg", "image"))
        elif message_type in {"file", "audio", "media", "video", "sticker"}:
            key = str(payload.get("file_key") or payload.get("image_key") or "")
            name = str(payload.get("file_name") or "")
            if message_type == "audio":
                name = name or f"{message_id}.opus"
                mime = "audio/ogg"
            elif message_type in {"media", "video"}:
                name = name or f"{message_id}.mp4"
                mime = "video/mp4"
            elif message_type == "sticker":
                name = name or f"{message_id}.png"
                mime = "image/png"
            else:
                name = name or "attachment"
                mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
            specs.append((key, name, mime, "file"))
        elif message_type == "post":
            post = _post_payload(payload)
            for paragraph in post.get("content", []) if isinstance(post.get("content"), list) else []:
                if not isinstance(paragraph, list):
                    continue
                for element in paragraph:
                    if isinstance(element, dict) and element.get("tag") == "img":
                        key = str(element.get("image_key") or "")
                        specs.append((key, f"{key or message_id}.jpg", "image/jpeg", "image"))
        attachments: list[ChatAttachment] = []
        for file_key, name, mime, resource_type in specs:
            if not file_key:
                continue
            attachment_id = f"{message_id}:{resource_type}:{file_key}"
            self._resources[attachment_id] = (message_id, file_key, resource_type)
            self._resources.move_to_end(attachment_id)
            while len(self._resources) > RESOURCE_CACHE_ITEMS:
                self._resources.popitem(last=False)
            attachments.append(ChatAttachment(id=attachment_id, name=name, mime=mime))
        return attachments

    async def fetch_attachment(
        self,
        attachment: ChatAttachment,
        *,
        max_bytes: int | None = None,
    ) -> bytes:
        if attachment.data is not None:
            if max_bytes is not None and len(attachment.data) > max_bytes:
                raise ValueError("feishu.attachment.download_limit")
            return attachment.data
        resource = self._resources.get(attachment.id)
        fetcher = getattr(self._transport, "fetch_resource", None)
        if resource is None or not callable(fetcher):
            return await super().fetch_attachment(attachment, max_bytes=max_bytes)
        message_id, file_key, resource_type = resource
        try:
            data = bytes(
                await _call(
                    fetcher,
                    message_id=message_id,
                    file_key=file_key,
                    resource_type=resource_type,
                )
            )
        except Exception as exc:
            logger.warning("feishu.resource_fetch_failed error=%s", type(exc).__name__)
            raise FileNotFoundError("feishu.attachment.unavailable") from None
        if max_bytes is not None and len(data) > max_bytes:
            raise ValueError("feishu.attachment.download_limit")
        self._resources.pop(attachment.id, None)
        return data

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
            components=[],
            embeds=[],
        )
        return await super().send_message(
            source,
            message,
            reply_to=reply_to,
            session_key=session_key,
        )

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
            return SendResult(ok=False, error=localize("feishu.client_unavailable"))
        private_target = message.private and source.chat_type.casefold() not in {"dm", "direct", "private"}
        if private_target and not source.user_id:
            return SendResult(ok=False, error="feishu.private_target.missing")
        receive_id = source.user_id if private_target else source.chat_id
        # _sender_open_id may fall back to user_id/union_id when the event has
        # no open_id, so derive the id type from the id itself instead of
        # assuming open_id (Feishu rejects a mismatched receive_id_type).
        receive_id_type = _receive_id_type_for(str(receive_id or "")) if private_target else "chat_id"
        effective_reply = None if private_target else reply_to
        payloads: list[tuple[str, str]] = []
        text = _render_text(message)
        if text:
            payloads.append(("text", json.dumps({"text": text}, ensure_ascii=False)))
        try:
            for attachment in message.attachments:
                payloads.append(await self._attachment_payload(attachment))
            if not payloads:
                return SendResult(ok=True)
            result = SendResult(ok=True)
            for msg_type, content in payloads:
                result = await self._send_payload(
                    receive_id=str(receive_id or ""),
                    receive_id_type=receive_id_type,
                    msg_type=msg_type,
                    content=content,
                    reply_to=effective_reply,
                )
                if not result.ok:
                    return result
            return result
        except Exception as exc:
            logger.warning("feishu.send_failed error=%s", type(exc).__name__)
            return SendResult(ok=False, error=localize("feishu.send_failed"))

    async def _attachment_payload(self, attachment: ChatAttachment) -> tuple[str, str]:
        data = attachment.data
        if data is None:
            raise FileNotFoundError(attachment.id or attachment.name)
        if attachment.mime.casefold().startswith("image/"):
            if len(data) > MAX_IMAGE_BYTES:
                raise ValueError("feishu.image.too_large")
            uploader = getattr(self._transport, "upload_image", None)
            if not callable(uploader):
                raise RuntimeError("feishu.image.upload_unavailable")
            response = await _call(uploader, data=data)
            if not _response_success(response):
                raise RuntimeError("feishu.image.upload_failed")
            key = _extract_resource_key(response, "image_key")
            if not key:
                raise RuntimeError("feishu.image_key.missing")
            return "image", json.dumps({"image_key": key}, ensure_ascii=False)
        if len(data) > MAX_FILE_BYTES:
            raise ValueError("feishu.file.too_large")
        uploader = getattr(self._transport, "upload_file", None)
        if not callable(uploader):
            raise RuntimeError("feishu.file.upload_unavailable")
        response = await _call(uploader, data=data, name=attachment.name)
        if not _response_success(response):
            raise RuntimeError("feishu.file.upload_failed")
        key = _extract_resource_key(response, "file_key")
        if not key:
            raise RuntimeError("feishu.file_key.missing")
        return "file", json.dumps({"file_key": key}, ensure_ascii=False)

    async def _send_payload(
        self,
        *,
        receive_id: str,
        receive_id_type: str,
        msg_type: str,
        content: str,
        reply_to: str | None,
    ) -> SendResult:
        message_api = getattr(getattr(getattr(self._transport, "im", None), "v1", None), "message", None)
        if message_api is None:
            return SendResult(ok=False, error=localize("feishu.client_unavailable"))
        if reply_to:
            method = getattr(message_api, "reply", None)
            if callable(method):
                response = await _call(
                    method,
                    message_id=reply_to,
                    msg_type=msg_type,
                    content=content,
                )
            else:
                response = await _call(
                    message_api.create,
                    receive_id=receive_id,
                    receive_id_type=receive_id_type,
                    msg_type=msg_type,
                    content=content,
                )
        else:
            response = await _call(
                message_api.create,
                receive_id=receive_id,
                receive_id_type=receive_id_type,
                msg_type=msg_type,
                content=content,
            )
        if not _response_success(response):
            return SendResult(ok=False, error=localize("feishu.send_failed"))
        return SendResult(ok=True, message_id=_extract_message_id(response))


def _accepts_argument(method: Any) -> bool:
    try:
        parameters = inspect.signature(method).parameters.values()
    except (TypeError, ValueError):
        return False
    return any(
        parameter.kind
        in {
            inspect.Parameter.POSITIONAL_ONLY,
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            inspect.Parameter.VAR_POSITIONAL,
        }
        for parameter in parameters
    )


platform_registry.register(
    PlatformEntry(
        name="feishu",
        label="Feishu",
        adapter_factory=lambda cfg, context: FeishuAdapter(cfg),
        check_fn=lambda: LARK_OAPI_AVAILABLE,
        required_env=["TRPG_FEISHU__APP_ID", "TRPG_FEISHU__APP_SECRET"],
        install_hint="uv sync --extra feishu",
    )
)
