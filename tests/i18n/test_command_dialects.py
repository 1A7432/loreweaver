import re

from agent.context import AgentCtx
from agent.services import build_services
from core.dice_engine import seed_dice
from core.rulepacks import load_rulepack
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
    return int(re.findall(r"-?\d+", text)[-1])


async def test_roll_dialects_are_numerically_consistent():
    services = _services()
    router = CommandRouter(services)
    en = AgentCtx(chat_key="cli:dm:t", user_id="u1", locale="en")
    zh = AgentCtx(chat_key="cli:dm:t", user_id="u1", locale="zh")

    seed_dice(91)
    en_result = await router.dispatch(en, "/roll 2d8+1")
    seed_dice(91)
    zh_result = await router.dispatch(zh, ".r 2d8+1")

    assert en_result is not None
    assert zh_result is not None
    assert _total(en_result) == _total(zh_result)


def test_slash_definitions_include_core_commands_and_valid_names():
    router = CommandRouter(_services())
    definitions = router.slash_definitions("en")
    names = {item["name"] for item in definitions}

    assert {"roll", "check", "sheet", "language", "init", "sc", "coc", "dnd", "setcoc", "help"} <= names
    for item in definitions:
        assert re.fullmatch(r"^[a-z0-9_-]{1,32}$", item["name"])
        assert item["description"]
        assert not item["description"].startswith("commands.")


def test_rulepack_aliases_resolve_en_and_zh_to_same_canonical():
    pack = load_rulepack("coc7")

    assert pack.resolve_skill("spot hidden") == "侦查"
    assert pack.resolve_skill("侦察") == "侦查"


def test_rulepacks_expose_creation_constraints():
    coc = load_rulepack("coc7").creation_constraints
    dnd = load_rulepack("dnd5e").creation_constraints

    assert coc["characteristics"]["STR"] == {"min": 15, "max": 90, "roll": "3d6x5"}
    assert coc["budgets"]["personal_interest_points"]["formula"] == "INT*2"
    assert dnd["methods"]["point_buy"]["budget"] == 27
    assert dnd["methods"]["standard_array"]["values"] == [15, 14, 13, 12, 10, 8]
