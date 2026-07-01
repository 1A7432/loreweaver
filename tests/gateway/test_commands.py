import re

from agent.context import AgentCtx
from agent.services import build_services
from core.dice_engine import seed_dice
from gateway.commands import CommandRouter
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM


def _services():
    return build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


def _total(text: str) -> int:
    matches = re.findall(r"=\s*(-?\d+)(?:\D*$|\n)", text)
    if matches:
        return int(matches[-1])
    numbers = re.findall(r"-?\d+", text)
    return int(numbers[-1])


async def test_en_commands_roll_inline_setcoc_make_and_check():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:t", user_id="u1", locale="en")

    seed_dice(10)
    rolled = await router.dispatch(ctx, "/roll 4d6kh3")
    assert rolled is not None
    assert "Roll:" in rolled
    assert _total(rolled) == 13

    seed_dice(2)
    inline = await router.dispatch(ctx, "attack [[1d20+5]] now")
    assert inline is not None
    assert "Inline" in inline
    assert _total(inline) == 7

    setcoc = await router.dispatch(ctx, "/setcoc 2")
    assert setcoc == "CoC rule set to 2."
    assert await services.store.get(user_key="", store_key="coc_rule.cli:dm:t") == "2"

    created = await router.dispatch(ctx, "/coc")
    assert created is not None
    assert "CoC" in created

    seed_dice(3)
    checked = await router.dispatch(ctx, "/check spot hidden")
    assert checked is not None
    assert "Check" in checked
    assert "侦查" in checked


async def test_zh_commands_roll_check_sheet_fullwidth_and_setcoc():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:t", user_id="u1", locale="zh")

    await router.dispatch(ctx, ".coc")

    seed_dice(10)
    rolled = await router.dispatch(ctx, ".r 3d6+2")
    assert rolled is not None
    assert "掷骰" in rolled
    assert _total(rolled) == 12

    seed_dice(4)
    checked = await router.dispatch(ctx, ".ra 侦查")
    assert checked is not None
    assert any(rank in checked for rank in ["大成功", "极难成功", "困难成功", "成功", "失败", "大失败"])

    seed_dice(4)
    hard = await router.dispatch(ctx, ".ra 困难侦查")
    assert hard is not None
    assert "有效 12" in hard

    changed = await router.dispatch(ctx, ".st 力量50")
    assert changed is not None
    assert "力量=50" in changed
    character = await services.characters.get_character("u1", "cli:dm:t")
    assert character.attributes["STR"] == 50

    seed_dice(10)
    fullwidth = await router.dispatch(ctx, "。r 3d6+2")
    assert fullwidth is not None
    assert _total(fullwidth) == 12

    setcoc = await router.dispatch(ctx, ".setcoc 2")
    assert setcoc == "CoC 房规已设为 2。"
    assert await services.store.get(user_key="", store_key="coc_rule.cli:dm:t") == "2"


async def test_both_dialects_use_same_roller_for_same_seed_and_expression():
    services = _services()
    router = CommandRouter(services)
    en = AgentCtx(chat_key="cli:dm:t", user_id="u1", locale="en")
    zh = AgentCtx(chat_key="cli:dm:t", user_id="u1", locale="zh")

    seed_dice(44)
    en_roll = await router.dispatch(en, "/roll 1d20+5")
    seed_dice(44)
    zh_roll = await router.dispatch(zh, ".r 1d20+5")

    assert en_roll is not None
    assert zh_roll is not None
    assert _total(en_roll) == _total(zh_roll)


async def test_report_command_exports_summary_without_keeper_permission():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:report", user_id="player", locale="en")

    await services.battles.start_session(ctx.chat_key, "Report Command")
    await services.battles.add_player_action(ctx.chat_key, "player", "Nora", "checks the locked desk")
    await services.battles.add_key_event(ctx.chat_key, "A silver key was recovered")

    report = await router.dispatch(ctx, ".report")

    assert report is not None
    assert "Report Command" in report
    assert "Player Scores" in report
    assert "Full Session Log" not in report
    assert "checks the locked desk" not in report


async def test_report_detailed_command_exports_full_transcript():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:report-detailed", user_id="player", locale="en")

    await services.battles.start_session(ctx.chat_key, "Detailed Command")
    await services.battles.add_player_action(ctx.chat_key, "player", "Nora", "checks the locked desk")
    await services.battles.add_skill_check(ctx.chat_key, "player", "Nora", "Locksmith", 50, 21, "success")

    report = await router.dispatch(ctx, ".report detailed")

    assert report is not None
    assert "Detailed Command" in report
    assert "Full Session Log" in report
    assert "checks the locked desk" in report
    assert "Locksmith (target 50): rolled 21" in report
