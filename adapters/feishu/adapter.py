"""Feishu/Lark gateway adapter.

Trimmed from the hermes-agent Feishu adapter design (MIT, Copyright 2025 Nous
Research).
"""

from __future__ import annotations

import inspect
import json
from types import SimpleNamespace
from typing import Any

from gateway.base_adapter import BaseAdapter, MessageHandler
from gateway.events import InboundMessage, SendResult
from gateway.registry import PlatformEntry, platform_registry
from gateway.session import SessionSource
from infra.i18n import t as localize

try:
    import lark_oapi as lark
    from lark_oapi.api.im.v1 import CreateMessageRequest, CreateMessageRequestBody

    LARK_OAPI_AVAILABLE = True
except ImportError:
    lark = None  # type: ignore[assignment]
    CreateMessageRequest = None  # type: ignore[assignment]
    CreateMessageRequestBody = None  # type: ignore[assignment]
    LARK_OAPI_AVAILABLE = False


class _LarkMessageTransport:
    def __init__(self, client: Any) -> None:
        self._client = client
        self.im = SimpleNamespace(v1=SimpleNamespace(message=SimpleNamespace(create=self.create)))

    def create(self, *, receive_id: str, msg_type: str, content: str) -> Any:
        if CreateMessageRequest is None or CreateMessageRequestBody is None:
            return None

        body = (
            CreateMessageRequestBody.builder()
            .receive_id(receive_id)
            .msg_type(msg_type)
            .content(content)
            .build()
        )
        request = CreateMessageRequest.builder().receive_id_type("chat_id").request_body(body).build()
        return self._client.im.v1.message.create(request)


def _config_value(config: Any, key: str) -> str:
    if isinstance(config, dict):
        value = config.get(key)
    else:
        value = getattr(config, key, None)
    return str(value or "")


def _build_transport(config: Any) -> Any | None:
    if not LARK_OAPI_AVAILABLE or lark is None:
        return None

    app_id = _config_value(config, "app_id")
    app_secret = _config_value(config, "app_secret")
    if not app_id or not app_secret:
        return None

    client = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()
    return _LarkMessageTransport(client)


def _event_payload(event: dict[str, Any]) -> dict[str, Any]:
    payload = event.get("event")
    return payload if isinstance(payload, dict) else event


def _message_payload(event: dict[str, Any]) -> dict[str, Any]:
    payload = _event_payload(event).get("message")
    return payload if isinstance(payload, dict) else {}


def _sender_open_id(event: dict[str, Any]) -> str | None:
    sender = _event_payload(event).get("sender")
    if not isinstance(sender, dict):
        return None
    sender_id = sender.get("sender_id")
    if not isinstance(sender_id, dict):
        return None
    open_id = sender_id.get("open_id")
    return str(open_id) if open_id else None


def _text_from_content(raw_content: Any) -> str:
    if raw_content is None:
        return ""
    if isinstance(raw_content, dict):
        payload = raw_content
    else:
        try:
            payload = json.loads(str(raw_content))
        except json.JSONDecodeError:
            return str(raw_content)

    if isinstance(payload, dict):
        text = payload.get("text")
        if text is not None:
            return str(text)
    return ""


def _extract_message_id(response: Any) -> str | None:
    if response is None:
        return None
    if isinstance(response, dict):
        data = response.get("data")
        if isinstance(data, dict) and data.get("message_id"):
            return str(data["message_id"])
        if response.get("message_id"):
            return str(response["message_id"])
        return None

    data = getattr(response, "data", None)
    message_id = getattr(data, "message_id", None) if data is not None else None
    if message_id is None:
        message_id = getattr(response, "message_id", None)
    return str(message_id) if message_id else None


def _response_success(response: Any) -> bool:
    success = getattr(response, "success", None)
    if callable(success):
        return bool(success())
    if isinstance(response, dict) and "ok" in response:
        return bool(response["ok"])
    return True


class FeishuAdapter(BaseAdapter):
    platform = "feishu"
    typed_command_prefix = "/"

    def __init__(
        self,
        config: Any = None,
        on_message: MessageHandler | None = None,
        transport: Any | None = None,
    ) -> None:
        if transport is None and on_message is not None and not callable(on_message):
            transport = on_message
            on_message = None
        super().__init__(config=config, on_message=on_message)
        self._transport = transport if transport is not None else _build_transport(config)

    async def connect(self) -> bool:
        return self._transport is not None

    async def disconnect(self) -> None:
        return None

    def to_inbound_message(self, event: dict[str, Any]) -> InboundMessage:
        message = _message_payload(event)
        chat_type = "group" if message.get("chat_type") == "group" else "dm"
        source = SessionSource(
            platform=self.platform,
            chat_type=chat_type,
            chat_id=str(message.get("chat_id") or ""),
            user_id=_sender_open_id(event),
            message_id=str(message.get("message_id") or "") or None,
        )
        return InboundMessage(
            source=source,
            text=_text_from_content(message.get("content")),
            raw=event,
        )

    async def handle_event(self, event: dict[str, Any]) -> InboundMessage | None:
        event_type = event.get("header", {}).get("event_type") if isinstance(event.get("header"), dict) else None
        if event_type and event_type != "im.message.receive_v1":
            return None

        inbound = self.to_inbound_message(event)
        await self.handle_inbound(inbound)
        return inbound

    async def send(self, source: SessionSource, content: str, *, reply_to: str | None = None) -> SendResult:
        del reply_to
        if self._transport is None:
            return SendResult(ok=False, error=localize("feishu.client_unavailable"))

        payload = json.dumps({"text": content}, ensure_ascii=False)
        response = self._transport.im.v1.message.create(
            receive_id=source.chat_id,
            msg_type="text",
            content=payload,
        )
        if inspect.isawaitable(response):
            response = await response

        if not _response_success(response):
            return SendResult(ok=False, error=localize("feishu.send_failed"))
        return SendResult(ok=True, message_id=_extract_message_id(response))


platform_registry.register(
    PlatformEntry(
        name="feishu",
        label="Feishu",
        adapter_factory=lambda cfg: FeishuAdapter(cfg),
        check_fn=lambda: True,
    )
)
