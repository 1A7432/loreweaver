"""Tests for agent.kp_tools_forge: the `generate_skill` GATED tool (Layer B.3a, `docs/plugins.md`
"Layer B").

Covers: (a) `generate_skill` is absent from `Toolset.schemas()` by default (no `unlocked`, or an
`unlocked` set that doesn't name it) and present once `unlocked={"generate_skill"}` -- what
`core.skills.unlocked_tools_for` supplies once the `skill-forge` skill is enabled for a room; (b)
`Toolset.dispatch` refuses it while locked (Layer B.2 defense in depth, mirroring
`tests/agent/test_tools.py`'s gated-tool coverage); (c) dispatched while unlocked, it installs a
skill end-to-end and returns a localized confirmation; (d) the `no_data_dir` failure surfaces as
the localized `agent.forge.no_data_dir` string.
"""

from __future__ import annotations

from pathlib import Path

import core.skills as skills_module
from agent.context import AgentCtx
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
