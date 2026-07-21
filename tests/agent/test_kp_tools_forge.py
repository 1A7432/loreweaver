"""Tests for agent.kp_tools_forge: the `generate_skill`/`generate_rulepack`/`generate_module`
GATED tools (Layer B.3, `docs/plugins.md` "Layer B").

Covers, for EACH of the three tools: (a) absent from `Toolset.schemas()` by default (no
`unlocked`, or an `unlocked` set that doesn't name it) and present once unlocked -- what
`core.skills.unlocked_tools_for` supplies once the matching forge skill is enabled for a room; (b)
`Toolset.dispatch` refuses it while locked (Layer B.2 defense in depth, mirroring
`tests/agent/test_tools.py`'s gated-tool coverage); (c) dispatched while unlocked, it installs
end-to-end and returns a localized confirmation; (d) the `no_data_dir` failure surfaces as the
matching localized string.
"""

from __future__ import annotations

import json
from pathlib import Path

import agent.forge as forge_module
import core.rulepacks as rulepacks_module
import core.skills as skills_module
from agent.context import AgentCtx, LocalFs
from agent.kp_tools import build_kp_toolset
from agent.services import build_services
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.i18n import t
from infra.llm import FakeLLM, assistant_text

VALID_SKILL_MD = """---
name: Grim Survival Horror
description: >
  Enable for a campaign about grinding, resource-scarce survival horror.
allowed-tools: []
metadata:
  scope: room
  content-rating: mature
---

# Grim survival horror

Track scarcity relentlessly.
"""

VALID_RULEPACK_YAML = """
names: [pulp-adventure, pulp]
set_keys: [pulp]
defaults:
  力量: 10
  意志: 10
derived:
  生命值上限:
    half_of: 意志
"""

CHAT_KEY_MODULE = "module-forge-tool-chat"
MODULE_SENTINEL = "THE FERRYMAN IS THE FEY BOUND TO THE OLD PACT"
GENERATED_MODULE_MD = f"""# The Salt Marsh Vanishing

## Premise
Fisherfolk have gone missing near the marsh town of Greyreed.

## KEEPER-ONLY
{MODULE_SENTINEL}.
"""


def _module_analysis_json() -> str:
    return json.dumps(
        {
            "npcs": [{"name": "The Ferryman", "description": "A quiet old man.", "secret": MODULE_SENTINEL, "role": "antagonist"}],
            "summary": "Investigators uncover the truth behind the marsh disappearances.",
        }
    )


def _services(content: str = VALID_SKILL_MD):
    return build_services(
        Settings(locale="en"),
        llm=FakeLLM(script=[assistant_text(content)]),
        embeddings=FakeEmbeddings(8),
    )


def test_generate_skill_absent_from_schemas_by_default() -> None:
    services = _services()
    toolset = build_kp_toolset(services)

    names = [schema["function"]["name"] for schema in toolset.schemas()]
    assert "generate_skill" not in names
    assert toolset.is_gated("generate_skill")


def test_generate_skill_absent_when_a_different_tool_is_unlocked() -> None:
    services = _services()
    toolset = build_kp_toolset(services)

    names = [schema["function"]["name"] for schema in toolset.schemas(unlocked={"some_other_tool"})]
    assert "generate_skill" not in names


def test_generate_skill_present_once_unlocked() -> None:
    services = _services()
    toolset = build_kp_toolset(services)

    names = [schema["function"]["name"] for schema in toolset.schemas(unlocked={"generate_skill"})]
    assert "generate_skill" in names


async def test_generate_skill_dispatch_refused_while_locked() -> None:
    services = _services()
    toolset = build_kp_toolset(services)
    ctx = AgentCtx(chat_key="chat-forge-locked", user_id="kp", locale="en")

    result = await toolset.dispatch("generate_skill", ctx, {"description": "anything"})

    assert result == t("agent.tools.tool_not_available", name="generate_skill")


async def test_generate_skill_dispatch_unlocked_installs_and_reports_success(tmp_path: Path) -> None:
    services = _services()
    toolset = build_kp_toolset(services)
    ctx = AgentCtx(chat_key="chat-forge-unlocked", user_id="kp", locale="en")

    original_user_dir = skills_module._USER_SKILL_DIR
    skills_module._USER_SKILL_DIR = tmp_path
    skills_module._discover_registry.cache_clear()
    try:
        result = await toolset.dispatch(
            "generate_skill",
            ctx,
            {"description": "a grim survival horror campaign"},
            unlocked={"generate_skill"},
        )

        assert "Grim Survival Horror" in result
        assert "grim-survival-horror" in result
        assert skills_module.load_skill("grim-survival-horror") is not None
    finally:
        skills_module._USER_SKILL_DIR = original_user_dir
        skills_module._discover_registry.cache_clear()


async def test_generate_skill_no_data_dir_reports_localized_message() -> None:
    services = _services()
    toolset = build_kp_toolset(services)
    ctx = AgentCtx(chat_key="chat-forge-no-dir", user_id="kp", locale="en")

    assert skills_module._USER_SKILL_DIR is None
    result = await toolset.dispatch(
        "generate_skill", ctx, {"description": "anything"}, unlocked={"generate_skill"}
    )

    assert result == t("agent.forge.no_data_dir")


# ---------------------------------------------------------------------------
# generate_rulepack
# ---------------------------------------------------------------------------


def test_generate_rulepack_absent_from_schemas_by_default() -> None:
    services = _services()
    toolset = build_kp_toolset(services)

    names = [schema["function"]["name"] for schema in toolset.schemas()]
    assert "generate_rulepack" not in names
    assert toolset.is_gated("generate_rulepack")


def test_generate_rulepack_present_once_unlocked() -> None:
    services = _services()
    toolset = build_kp_toolset(services)

    names = [schema["function"]["name"] for schema in toolset.schemas(unlocked={"generate_rulepack"})]
    assert "generate_rulepack" in names


async def test_generate_rulepack_dispatch_refused_while_locked() -> None:
    services = _services()
    toolset = build_kp_toolset(services)
    ctx = AgentCtx(chat_key="chat-rulepack-forge-locked", user_id="kp", locale="en")

    result = await toolset.dispatch("generate_rulepack", ctx, {"description": "anything"})

    assert result == t("agent.tools.tool_not_available", name="generate_rulepack")


async def test_generate_rulepack_dispatch_unlocked_installs_and_reports_success(tmp_path: Path) -> None:
    services = _services(VALID_RULEPACK_YAML)
    toolset = build_kp_toolset(services)
    ctx = AgentCtx(chat_key="chat-rulepack-forge-unlocked", user_id="kp", locale="en")

    original_user_dir = rulepacks_module._USER_RULEPACK_DIR
    rulepacks_module._USER_RULEPACK_DIR = tmp_path
    rulepacks_module._discover_registry.cache_clear()
    rulepacks_module._alias_resolver.cache_clear()
    try:
        result = await toolset.dispatch(
            "generate_rulepack",
            ctx,
            {"description": "a pulp adventure system"},
            unlocked={"generate_rulepack"},
        )

        assert "pulp-adventure" in result
        assert "pulp-adventure" in rulepacks_module.available_systems()
    finally:
        rulepacks_module._USER_RULEPACK_DIR = original_user_dir
        rulepacks_module._discover_registry.cache_clear()
        rulepacks_module._alias_resolver.cache_clear()


async def test_generate_rulepack_no_data_dir_reports_localized_message() -> None:
    services = _services(VALID_RULEPACK_YAML)
    toolset = build_kp_toolset(services)
    ctx = AgentCtx(chat_key="chat-rulepack-forge-no-dir", user_id="kp", locale="en")

    assert rulepacks_module._USER_RULEPACK_DIR is None
    result = await toolset.dispatch(
        "generate_rulepack", ctx, {"description": "anything"}, unlocked={"generate_rulepack"}
    )

    assert result == t("agent.forge.rulepack_no_data_dir")


# ---------------------------------------------------------------------------
# generate_module
# ---------------------------------------------------------------------------


def test_generate_module_absent_from_schemas_by_default() -> None:
    services = _services()
    toolset = build_kp_toolset(services)

    names = [schema["function"]["name"] for schema in toolset.schemas()]
    assert "generate_module" not in names
    assert toolset.is_gated("generate_module")


def test_generate_module_present_once_unlocked() -> None:
    services = _services()
    toolset = build_kp_toolset(services)

    names = [schema["function"]["name"] for schema in toolset.schemas(unlocked={"generate_module"})]
    assert "generate_module" in names


async def test_generate_module_dispatch_refused_while_locked() -> None:
    services = _services()
    toolset = build_kp_toolset(services)
    ctx = AgentCtx(chat_key="chat-module-forge-locked", user_id="kp", locale="en")

    result = await toolset.dispatch("generate_module", ctx, {"description": "anything"})

    assert result == t("agent.tools.tool_not_available", name="generate_module")


async def test_generate_module_dispatch_unlocked_installs_and_reports_success(tmp_path: Path) -> None:
    services = build_services(
        Settings(locale="en"),
        llm=FakeLLM(script=[assistant_text(GENERATED_MODULE_MD), assistant_text(_module_analysis_json())]),
        embeddings=FakeEmbeddings(8),
    )
    toolset = build_kp_toolset(services)
    ctx = AgentCtx(chat_key=CHAT_KEY_MODULE, user_id="kp", locale="en", fs=LocalFs(base_dir=tmp_path))

    original_user_dir = forge_module._USER_MODULE_DIR
    forge_module._USER_MODULE_DIR = tmp_path / "modules"
    try:
        result = await toolset.dispatch(
            "generate_module",
            ctx,
            {"description": "a marsh-town disappearance mystery"},
            unlocked={"generate_module"},
        )

        assert "The Salt Marsh Vanishing" in result

        status = await services.store.get(user_key="", store_key=f"module_init_status.{CHAT_KEY_MODULE}")
        assert status == "ready"
    finally:
        forge_module._USER_MODULE_DIR = original_user_dir


async def test_generate_module_repeat_dispatch_reports_suppression(tmp_path: Path) -> None:
    services = build_services(
        Settings(locale="en"),
        llm=FakeLLM(
            script=[assistant_text(GENERATED_MODULE_MD), assistant_text(_module_analysis_json())]
        ),
        embeddings=FakeEmbeddings(8),
    )
    toolset = build_kp_toolset(services)
    ctx = AgentCtx(
        chat_key=CHAT_KEY_MODULE,
        user_id="kp",
        locale="en",
        fs=LocalFs(base_dir=tmp_path),
    )

    original_user_dir = forge_module._USER_MODULE_DIR
    forge_module._USER_MODULE_DIR = tmp_path / "modules"
    try:
        await toolset.dispatch(
            "generate_module",
            ctx,
            {"description": "A Marsh-Town  Disappearance Mystery"},
            unlocked={"generate_module"},
        )
        repeated = await toolset.dispatch(
            "generate_module",
            ctx,
            {"description": " a marsh-town disappearance mystery "},
            unlocked={"generate_module"},
        )

        path = tmp_path / "modules" / "the-salt-marsh-vanishing.md"
        assert repeated == t(
            "agent.forge.module_reused",
            name="The Salt Marsh Vanishing",
            path=str(path.resolve()),
        )
        assert len(services.llm.calls) == 2
    finally:
        forge_module._USER_MODULE_DIR = original_user_dir


async def test_generate_module_no_data_dir_reports_localized_message() -> None:
    services = _services()
    toolset = build_kp_toolset(services)
    ctx = AgentCtx(chat_key="chat-module-forge-no-dir", user_id="kp", locale="en")

    assert forge_module._USER_MODULE_DIR is None
    result = await toolset.dispatch(
        "generate_module", ctx, {"description": "anything"}, unlocked={"generate_module"}
    )

    assert result == t("agent.forge.module_no_data_dir")
