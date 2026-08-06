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


async def test_discipline_and_fidelity_blocks_ride_world_lore_in_module_rooms(tmp_path):
    """A card-imported room has no knowledge pool, so the pool section's
    keeper_discipline/module_fidelity blocks used to never fire — the model ran whole
    imported modules with neither block in context. They fold in ahead of the lore
    section (exactly once) when world lore injects in a room the keeper's
    `.import … world` marked as running a module."""
    from core.worldbook import LoreEntry

    captured_prompts: list[str] = []

    def responder(messages, tools):
        captured_prompts.append(messages[0]["content"])
        return assistant_text("The rain thickens.")

    services = _services(FakeLLM(responder=responder))
    ctx = AgentCtx(chat_key="discipline-room", user_id="p1", locale="en")
    await services.worldbook.add(
        "discipline-room",
        LoreEntry(id="", title="模组规则", content="访客审判每日一次。", constant=True),
    )
    # The durable marker `.import … world` persists (agent.kp_tools_charcard).
    await services.store.set(user_key="", store_key="world_import.discipline-room", value="测试模组")

    await run_kp_turn(ctx, services, build_kp_toolset(services), "开始今天的审判。")

    prompt = captured_prompts[-1]
    i18n = services.i18n.with_locale("en")
    assert prompt.count(i18n.t("prompt.keeper_discipline")) == 1
    assert prompt.count(i18n.t("prompt.module_fidelity")) == 1
    # And ahead of the lore section they govern.
    assert prompt.index(i18n.t("prompt.keeper_discipline")) < prompt.index("访客审判每日一次。")


async def test_sandbox_lore_never_pulls_in_module_directives(tmp_path):
    """A free-sandbox room whose keeper merely `.lore add`ed setting notes must get its
    lore WITHOUT the run-the-module blocks: there is no module to be faithful to, and
    improvising is the keeper's job there."""
    from core.worldbook import LoreEntry

    captured_prompts: list[str] = []

    def responder(messages, tools):
        captured_prompts.append(messages[0]["content"])
        return assistant_text("The tavern hums.")

    services = _services(FakeLLM(responder=responder))
    ctx = AgentCtx(chat_key="sandbox-room", user_id="p1", locale="en")
    await services.worldbook.add(
        "sandbox-room",
        LoreEntry(id="", title="酒馆设定", content="酒馆的地窖通向旧运河。", constant=True),
    )

    await run_kp_turn(ctx, services, build_kp_toolset(services), "我们在酒馆里聊聊。")

    prompt = captured_prompts[-1]
    i18n = services.i18n.with_locale("en")
    assert "酒馆的地窖通向旧运河。" in prompt  # the lore itself still injects
    assert i18n.t("prompt.module_fidelity") not in prompt
    assert i18n.t("prompt.keeper_discipline") not in prompt


async def test_no_world_lore_means_no_discipline_fold(tmp_path):
    captured_prompts: list[str] = []

    def responder(messages, tools):
        captured_prompts.append(messages[0]["content"])
        return assistant_text("A calm night.")

    services = _services(FakeLLM(responder=responder))
    ctx = AgentCtx(chat_key="plain-room", user_id="p1", locale="en")

    await run_kp_turn(ctx, services, build_kp_toolset(services), "我们聊聊天。")

    i18n = services.i18n.with_locale("en")
    assert i18n.t("prompt.module_fidelity") not in captured_prompts[-1]
