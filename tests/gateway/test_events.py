from gateway.events import InboundMessage, SendResult
from gateway.session import SessionSource


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
