from __future__ import annotations

import asyncio

from agent.services import build_services
from gateway.base_adapter import BaseAdapter
from gateway.chat import ChatCapabilities, ChatMessage
from gateway.events import InboundMessage, SendResult
from gateway.runner import GatewayRunner
from gateway.session import SessionSource
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM


class LifecycleAdapter(BaseAdapter):
    def __init__(self, platform: str, *, connect_result=True, disconnect_error=False) -> None:
        super().__init__()
        self.platform = platform
        self.connect_result = connect_result
        self.disconnect_error = disconnect_error
        self.connect_calls = 0
        self.disconnect_calls = 0

    async def connect(self) -> bool:
        self.connect_calls += 1
        if isinstance(self.connect_result, BaseException):
            raise self.connect_result
        return bool(self.connect_result)

    async def disconnect(self) -> None:
        self.disconnect_calls += 1
        if self.disconnect_error:
            raise RuntimeError("adapter secret must not escape")

    async def _send_message(
        self,
        source: SessionSource,
        message: ChatMessage,
        *,
        reply_to: str | None,
        session_key: str | None,
    ) -> SendResult:
        del source, message, reply_to, session_key
        return SendResult(ok=True)


class BlockingConnectAdapter(LifecycleAdapter):
    def __init__(self, platform: str) -> None:
        super().__init__(platform)
        self.started = asyncio.Event()

    async def connect(self) -> bool:
        self.connect_calls += 1
        self.started.set()
        await asyncio.Future()
        return True


class BlockingDisconnectAdapter(LifecycleAdapter):
    def __init__(self, platform: str) -> None:
        super().__init__(platform)
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def disconnect(self) -> None:
        self.disconnect_calls += 1
        self.started.set()
        await self.release.wait()


class TypingAdapter(LifecycleAdapter):
    capabilities = ChatCapabilities(typing=True)

    def __init__(self, platform: str) -> None:
        super().__init__(platform)
        self.typing: list[bool] = []

    async def set_typing(self, _source: SessionSource, active: bool) -> None:
        self.typing.append(active)


def _runner(adapters: list[BaseAdapter], data_dir: str) -> GatewayRunner:
    services = build_services(
        Settings(_env_file=None, data_dir=data_dir),
        llm=FakeLLM(script=[]),
        embeddings=FakeEmbeddings(64),
    )
    return GatewayRunner(services, adapters)


async def test_start_isolates_failed_adapters_and_cleans_partial_state(caplog, tmp_path) -> None:
    healthy = LifecycleAdapter("healthy")
    unavailable = LifecycleAdapter("unavailable", connect_result=False)
    broken = LifecycleAdapter("broken", connect_result=RuntimeError("credential=secret"))
    runner = _runner([healthy, unavailable, broken], str(tmp_path))

    failed = await runner.start()

    assert failed == ["unavailable", "broken"]
    # Failed adapters are dropped so stop() cannot disconnect them a second time.
    assert runner.adapters == [healthy]
    assert [item.connect_calls for item in (healthy, unavailable, broken)] == [1, 1, 1]
    assert [item.disconnect_calls for item in (healthy, unavailable, broken)] == [0, 1, 1]
    assert healthy._message_handler == runner.on_inbound
    assert "credential=secret" not in caplog.text

    await runner.stop()
    assert [item.disconnect_calls for item in (healthy, unavailable, broken)] == [1, 1, 1]
    runner.services.store.close()


async def test_stop_attempts_every_adapter_when_one_disconnect_fails(caplog, tmp_path) -> None:
    broken = LifecycleAdapter("broken", disconnect_error=True)
    healthy = LifecycleAdapter("healthy")
    runner = _runner([broken, healthy], str(tmp_path))

    await runner.stop()

    assert broken.disconnect_calls == 1
    assert healthy.disconnect_calls == 1
    assert "adapter secret must not escape" not in caplog.text
    runner.services.store.close()


async def test_start_does_not_swallow_task_cancellation(tmp_path) -> None:
    cancelled = LifecycleAdapter("cancelled", connect_result=asyncio.CancelledError())
    runner = _runner([cancelled], str(tmp_path))

    try:
        await runner.start()
    except asyncio.CancelledError:
        pass
    else:
        raise AssertionError("runner.start() swallowed cancellation")
    finally:
        runner.services.store.close()
    assert cancelled.disconnect_calls == 1


async def test_external_start_cancellation_cleans_every_adapter(tmp_path) -> None:
    healthy = LifecycleAdapter("healthy")
    blocking = BlockingConnectAdapter("blocking")
    runner = _runner([healthy, blocking], str(tmp_path))
    start_task = asyncio.create_task(runner.start())
    await blocking.started.wait()

    start_task.cancel()
    try:
        await start_task
    except asyncio.CancelledError:
        pass
    else:
        raise AssertionError("runner.start() swallowed external cancellation")

    assert healthy.disconnect_calls == 1
    assert blocking.disconnect_calls == 1
    runner.services.store.close()


async def test_external_stop_cancellation_waits_for_cleanup(tmp_path) -> None:
    blocking = BlockingDisconnectAdapter("blocking")
    runner = _runner([blocking], str(tmp_path))
    stop_task = asyncio.create_task(runner.stop())
    await blocking.started.wait()

    stop_task.cancel()
    await asyncio.sleep(0)
    assert stop_task.done() is False
    blocking.release.set()
    try:
        await stop_task
    except asyncio.CancelledError:
        pass
    else:
        raise AssertionError("runner.stop() swallowed external cancellation")

    assert blocking.disconnect_calls == 1
    runner.services.store.close()


async def test_runner_starts_typing_only_after_all_cheap_gates(tmp_path) -> None:
    adapter = TypingAdapter("telegram")
    runner = _runner([adapter], str(tmp_path))
    source = SessionSource(
        platform="telegram",
        chat_type="group",
        chat_id="group",
        user_id="user",
    )

    assert await runner.on_inbound(InboundMessage(source=source, text="hello")) is None
    assert adapter.typing == []

    bot_source = SessionSource(
        platform="telegram",
        chat_type="group",
        chat_id="group",
        user_id="bot",
        is_bot=True,
    )
    assert await runner.on_inbound(InboundMessage(source=bot_source, text=".help")) is None
    assert adapter.typing == []

    runner.rate_limiter.allow = lambda _key: False
    throttled = await runner.on_inbound(
        InboundMessage(source=source, text=".help", at_bot=True)
    )
    assert throttled is not None
    assert adapter.typing == []

    runner.rate_limiter.allow = lambda _key: True
    reply = await runner.on_inbound(InboundMessage(source=source, text=".help", at_bot=True))
    assert reply is not None
    assert adapter.typing == [True, False]
    runner.services.store.close()
