"""Live-play worldbook retrieval context (the 2026-08-05 play-test's headline bug):
`run_kp_turn` must hand THIS turn's player message to the prompt builder as
`ctx.extra["user_message"]`, so keyword-triggered lore actually fires in live rooms —
before the fix nothing ever wrote that key and imported lorebooks were a dead zone."""

from __future__ import annotations

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.loop import run_kp_turn
from agent.services import build_services
from core.worldbook import LoreEntry
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text


def _services(llm):
    return build_services(Settings(locale="en"), llm=llm, embeddings=FakeEmbeddings(64))


async def test_player_message_reaches_worldbook_injection(tmp_path):
    captured_prompts: list[str] = []

    def responder(messages, tools):
        captured_prompts.append(messages[0]["content"])
        return assistant_text("The lighthouse looms.")

    services = _services(FakeLLM(responder=responder))
    ctx = AgentCtx(chat_key="wb-live-room", user_id="p1", locale="en")
    await services.worldbook.add(
        "wb-live-room",
        LoreEntry(id="", title="灯塔的秘密史", content="灯塔曾三次易主，塔顶封存着旧日志。", keys=["灯塔"]),
    )

    await run_kp_turn(ctx, services, build_kp_toolset(services), "我走向灯塔，抬头看塔顶。")

    assert ctx.extra["user_message"] == "我走向灯塔，抬头看塔顶。"
    assert any("灯塔曾三次易主" in prompt for prompt in captured_prompts)


async def test_unrelated_message_does_not_fire_keyword_lore(tmp_path):
    captured_prompts: list[str] = []

    def responder(messages, tools):
        captured_prompts.append(messages[0]["content"])
        return assistant_text("A quiet evening.")

    services = _services(FakeLLM(responder=responder))
    ctx = AgentCtx(chat_key="wb-quiet-room", user_id="p1", locale="en")
    await services.worldbook.add(
        "wb-quiet-room",
        LoreEntry(id="", title="灯塔的秘密史", content="灯塔曾三次易主，塔顶封存着旧日志。", keys=["灯塔"]),
    )

    await run_kp_turn(ctx, services, build_kp_toolset(services), "我在酒馆里点了一杯麦酒。")

    assert all("灯塔曾三次易主" not in prompt for prompt in captured_prompts)
