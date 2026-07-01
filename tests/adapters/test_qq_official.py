from adapters.qq_official import QQOfficialAdapter
from gateway.events import InboundMessage
from gateway.session import SessionSource
from infra.store import Store


class MockTransport:
    def __init__(self) -> None:
        self.sent = []

    async def ws(self, *_args, **_kwargs):
        return True

    async def send(self, method, path, body):
        self.sent.append({"method": method, "path": path, "body": body})
        return {"id": f"sent-{len(self.sent)}"}


def _group_payload(event_type: str, gid: str = "gid", uid: str = "uid", mid: str = "mid", content: str = "hello"):
    return {
        "op": 0,
        "t": event_type,
        "s": 1,
        "d": {
            "id": mid,
            "group_openid": gid,
            "content": content,
            "author": {"member_openid": uid},
        },
    }


def _c2c_payload(uid: str = "user-openid", mid: str = "dm-1", content: str = "hi"):
    return {
        "op": 0,
        "t": "C2C_MESSAGE_CREATE",
        "s": 1,
        "d": {
            "id": mid,
            "content": content,
            "author": {"user_openid": uid},
        },
    }


def _adapter(store: Store, transport: MockTransport | None = None) -> QQOfficialAdapter:
    return QQOfficialAdapter(
        {"app_id": "app", "secret": "secret", "token": "token", "store": store},
        transport=transport or MockTransport(),
    )


async def test_group_at_message_create_emits_at_bot_inbound_with_group_chat_key() -> None:
    store = Store(":memory:")
    adapter = _adapter(store)
    received: list[InboundMessage] = []

    async def handler(msg: InboundMessage) -> str | None:
        received.append(msg)
        return None

    adapter.set_message_handler(handler)

    await adapter.dispatch_payload(_group_payload("GROUP_AT_MESSAGE_CREATE", gid="group-1", mid="m1"))

    assert len(received) == 1
    assert received[0].at_bot is True
    assert received[0].source.chat_key() == "qq:group:group-1"


async def test_group_message_create_emits_non_at_inbound_for_full_message_extension() -> None:
    store = Store(":memory:")
    adapter = _adapter(store)
    received: list[InboundMessage] = []

    async def handler(msg: InboundMessage) -> str | None:
        received.append(msg)
        return None

    adapter.set_message_handler(handler)

    await adapter.dispatch_payload(_group_payload("GROUP_MESSAGE_CREATE", gid="group-2", mid="m2"))

    assert len(received) == 1
    assert received[0].at_bot is False


async def test_first_group_message_create_flips_mode_to_full_and_allows_proactive() -> None:
    store = Store(":memory:")
    adapter = _adapter(store)
    source = SessionSource(platform="qq", chat_type="group", chat_id="group-3")

    assert adapter.supports_proactive(source) is False
    assert await store.get(store_key="qq_group_mode.group-3") is None

    await adapter.dispatch_payload(_group_payload("GROUP_MESSAGE_CREATE", gid="group-3", mid="m3"))

    assert await store.get(store_key="qq_group_mode.group-3") == "full"
    assert adapter.supports_proactive(source) is True


async def test_at_only_group_enable_hint_is_sent_once() -> None:
    store = Store(":memory:")
    transport = MockTransport()
    adapter = _adapter(store, transport)

    await adapter.dispatch_payload(_group_payload("GROUP_AT_MESSAGE_CREATE", gid="group-4", mid="m4a"))
    await adapter.dispatch_payload(_group_payload("GROUP_AT_MESSAGE_CREATE", gid="group-4", mid="m4b"))

    assert len(transport.sent) == 1
    assert transport.sent[0]["path"] == "/v2/groups/group-4/messages"
    assert transport.sent[0]["body"]["msg_id"] == "m4a"
    assert await store.get(store_key="qq_hint_sent.group-4") == "1"


async def test_passive_reply_send_includes_msg_id_token() -> None:
    store = Store(":memory:")
    transport = MockTransport()
    adapter = _adapter(store, transport)
    await store.set(store_key="qq_hint_sent.group-5", value="1")

    async def handler(_msg: InboundMessage) -> str | None:
        return "reply text"

    adapter.set_message_handler(handler)

    await adapter.dispatch_payload(_group_payload("GROUP_AT_MESSAGE_CREATE", gid="group-5", mid="m5"))

    assert len(transport.sent) == 1
    assert transport.sent[0]["body"]["msg_id"] == "m5"


async def test_c2c_message_create_emits_dm_inbound_with_full_availability() -> None:
    store = Store(":memory:")
    adapter = _adapter(store)
    received: list[InboundMessage] = []

    async def handler(msg: InboundMessage) -> str | None:
        received.append(msg)
        return None

    adapter.set_message_handler(handler)

    await adapter.dispatch_payload(_c2c_payload(uid="user-1", mid="dm-2"))

    assert len(received) == 1
    assert received[0].source.chat_type == "dm"
    assert received[0].source.chat_key() == "qq:dm:user-1"
    assert adapter.supports_proactive(received[0].source) is True
