from dataclasses import FrozenInstanceError

import pytest

from gateway.events import (
    Commentary,
    GatewayNotice,
    InboundMessage,
    MessageChunk,
    MessageStop,
    SendResult,
    ToolCallChunk,
    ToolCallFinished,
)
from gateway.session import SessionSource


def test_stream_events_construct_and_are_frozen() -> None:
    events = [
        MessageChunk("hello"),
        MessageStop(final=True),
        Commentary("thinking"),
        ToolCallChunk("roll", preview="1d20", args={"expr": "1d20"}, index=1),
        ToolCallFinished("roll", duration=0.5, ok=True, index=1),
        GatewayNotice("online", text="ready", extra={"platform": "cli"}),
    ]

    for event in events:
        field_name = next(iter(event.__dict__))
        with pytest.raises(FrozenInstanceError):
            setattr(event, field_name, "changed")


def test_inbound_message_and_send_result_fields() -> None:
    source = SessionSource(platform="cli", chat_id="local", chat_type="dm", message_id="m1")
    inbound = InboundMessage(source=source, text="hi", at_bot=True, raw={"id": "m1"})
    result = SendResult(ok=True, message_id="m2")

    assert inbound.source is source
    assert inbound.text == "hi"
    assert inbound.at_bot is True
    assert inbound.raw == {"id": "m1"}
    assert result.ok is True
    assert result.message_id == "m2"
    assert result.error is None
