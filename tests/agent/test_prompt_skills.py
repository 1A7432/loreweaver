"""Tests for the KP-skills prompt binding (Layer B.1 — `agent.prompt_builder`
folding enabled-skill bodies into the system prompt, last, per room).

Uses a temporary `core.skills._SKILL_DIR` fixture skill (never the real
`skills/` contents beyond confirming `mature-mode` exists, which
`tests/core/test_skills.py` already covers) so this stays independent of
whatever built-in skills ship.
"""

from __future__ import annotations

import json
from pathlib import Path

import core.skills as skills_module
from agent.context import AgentCtx
from agent.prompt_builder import build_system_prompt
from agent.services import build_services
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM

FIXTURE_SKILL = """---
name: Fixture Skill
description: A skill used purely to test the prompt-binding layer.
allowed-tools: []
metadata:
  scope: room
  content-rating: mature
---

# Fixture Skill Directive

SENTINEL_FIXTURE_SKILL_BODY_MARKER
"""


def _services(locale: str = "en"):
    settings = Settings(locale=locale)
    return build_services(settings, llm=FakeLLM(), embeddings=FakeEmbeddings(64))


def _use_tmp_skill_dir(tmp_path: Path, skill_id: str = "fixture-skill") -> Path:
    skill_dir = tmp_path / skill_id
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(FIXTURE_SKILL, encoding="utf-8")
    return tmp_path


async def test_no_skills_enabled_prompt_is_unchanged_by_the_skills_layer():
    services = _services("en")
    ctx = AgentCtx(chat_key="chat-skills-none", user_id="u1", locale="en")

    prompt = await build_system_prompt(ctx, services)
    i18n = services.i18n.with_locale("en")

    assert i18n.t("prompt.skills_header") not in prompt


async def test_no_skills_enabled_prompt_is_byte_identical_between_two_fresh_rooms():
    """A room with no `skills_enabled.*` flag at all, and one whose flag decodes to
    an explicit empty list, must both build the EXACT SAME prompt (given identical
    seed state) as a room that predates the skills layer entirely -- zero regression."""
    services = _services("en")
    ctx_a = AgentCtx(chat_key="chat-skills-baseline-a", user_id="u1", locale="en")
    ctx_b = AgentCtx(chat_key="chat-skills-baseline-b", user_id="u1", locale="en")
    await services.store.set(store_key=f"skills_enabled.{ctx_b.chat_key}", value=json.dumps([]))

    prompt_a = await build_system_prompt(ctx_a, services)
    prompt_b = await build_system_prompt(ctx_b, services)

    assert prompt_a == prompt_b


async def test_enabled_skill_body_is_folded_in_as_the_final_section(tmp_path):
    services = _services("en")
    chat_key = "chat-skills-enabled"
    ctx = AgentCtx(chat_key=chat_key, user_id="u1", locale="en")
    i18n = services.i18n.with_locale("en")

    original_dir = skills_module._SKILL_DIR
    skills_module._SKILL_DIR = _use_tmp_skill_dir(tmp_path)
    skills_module._discover_registry.cache_clear()
    try:
        baseline = await build_system_prompt(ctx, services)
        assert "SENTINEL_FIXTURE_SKILL_BODY_MARKER" not in baseline

        await services.store.set(store_key=f"skills_enabled.{chat_key}", value=json.dumps(["fixture-skill"]))
        with_skill = await build_system_prompt(ctx, services)

        assert "SENTINEL_FIXTURE_SKILL_BODY_MARKER" in with_skill
        assert i18n.t("prompt.skills_header") in with_skill
        # The skill section is the FINAL section: the baseline prompt is a strict
        # prefix of the skill-enabled prompt (skills fold in LAST, nothing before
        # it changes).
        assert with_skill.startswith(baseline)
        assert with_skill[len(baseline) :].startswith("\n\n" + i18n.t("prompt.skills_header"))
    finally:
        skills_module._SKILL_DIR = original_dir
        skills_module._discover_registry.cache_clear()


async def test_unknown_enabled_skill_id_is_skipped_not_fatal():
    """An id enabled for a room that no longer resolves to a discoverable skill
    (e.g. its directory was removed) must be silently skipped, not crash the turn."""
    services = _services("en")
    chat_key = "chat-skills-unknown-id"
    ctx = AgentCtx(chat_key=chat_key, user_id="u1", locale="en")
    await services.store.set(
        store_key=f"skills_enabled.{chat_key}", value=json.dumps(["definitely-not-a-real-skill"])
    )

    prompt = await build_system_prompt(ctx, services)
    i18n = services.i18n.with_locale("en")

    assert i18n.t("prompt.skills_header") not in prompt
