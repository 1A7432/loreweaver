"""Security regression tests for agent.kp_tools_mechanics.

Covers two confirmed findings:

1. SILENT CHARACTER WIPE — a mutating tool run against a character whose stored
   row is corrupt must return a localized error and leave BOTH the stored row
   and the shared party roster untouched (previously it saved a blank sheet
   over the real character and the roster).
2. WOD POOL DoS — `wod_check` with a wildly out-of-range `pool_size` must
   return fast with a bounded, localized message instead of allocating a giant
   list and blocking the event loop.

Services are built fully offline (`FakeLLM`/`FakeEmbeddings`); see the sibling
`test_kp_tools_mechanics.py` for the `_build` convention.
"""

from __future__ import annotations

import json
import time

import pytest

from agent.context import AgentCtx
from agent.kp_tools_mechanics import CharacterTools, DiceTools
from agent.services import Services, build_services
from core.dice_engine import _MAX_WOD_POOL, seed_dice
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM


def _build() -> tuple[Services, AgentCtx]:
    services = build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    ctx = AgentCtx(chat_key="cli:dm:t", user_id="u1")
    return services, ctx


# ---------------------------------------------------------------------------
# Finding 1 — corrupt row must not be wiped by a mutating tool
# ---------------------------------------------------------------------------


async def test_update_skill_on_corrupt_row_errors_and_wipes_nothing():
    services, ctx = _build()
    char_tools = CharacterTools(services)

    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=True)

    char_key = f"characters.{ctx.chat_key}.Vera"
    roster_key = f"party_roster.{ctx.chat_key}"
    roster_before = await services.store.get(user_key="", store_key=roster_key)
    assert roster_before is not None and "Vera" in roster_before

    # Corrupt the stored row (truncated JSON), mimicking a partial/failed write.
    corrupt_value = '{"name": "Vera", "sys'
    await services.store.set(user_key=ctx.uid(), store_key=char_key, value=corrupt_value)

    result = await char_tools.update_character_skill(ctx, skill_name="侦查", value=70)

    i18n = services.i18n.with_locale(ctx.locale)
    assert result == i18n.t("kp_tools.character.data_error")

    # The corrupt row was NOT overwritten with a blank sheet...
    assert await services.store.get(user_key=ctx.uid(), store_key=char_key) == corrupt_value
    # ...and the shared party roster is byte-for-byte unchanged.
    assert await services.store.get(user_key="", store_key=roster_key) == roster_before


async def test_update_attribute_on_corrupt_row_errors_and_wipes_nothing():
    services, ctx = _build()
    char_tools = CharacterTools(services)

    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=True)

    char_key = f"characters.{ctx.chat_key}.Vera"
    roster_key = f"party_roster.{ctx.chat_key}"
    roster_before = await services.store.get(user_key="", store_key=roster_key)

    corrupt_value = "not-json-at-all"
    await services.store.set(user_key=ctx.uid(), store_key=char_key, value=corrupt_value)

    result = await char_tools.update_character_attribute(ctx, attribute="STR", value=80)

    i18n = services.i18n.with_locale(ctx.locale)
    assert result == i18n.t("kp_tools.character.data_error")
    assert await services.store.get(user_key=ctx.uid(), store_key=char_key) == corrupt_value
    assert await services.store.get(user_key="", store_key=roster_key) == roster_before


async def test_get_character_sheet_on_corrupt_row_degrades_gracefully():
    """A read-only sheet view must not raise on a corrupt row — it degrades to a message."""
    services, ctx = _build()
    char_tools = CharacterTools(services)

    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=True)
    await services.store.set(
        user_key=ctx.uid(), store_key=f"characters.{ctx.chat_key}.Vera", value="{corrupt"
    )

    result = await char_tools.get_character_sheet(ctx)

    i18n = services.i18n.with_locale(ctx.locale)
    assert result == i18n.t("kp_tools.character.data_error")


async def test_healthy_row_still_updates_normally():
    """The fix must not break the happy path."""
    services, ctx = _build()
    char_tools = CharacterTools(services)

    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=True)
    result = await char_tools.update_character_skill(ctx, skill_name="侦查", value=70)

    i18n = services.i18n.with_locale(ctx.locale)
    assert result != i18n.t("kp_tools.character.data_error")
    assert "Vera" in result

    stored = await services.store.get(user_key=ctx.uid(), store_key=f"characters.{ctx.chat_key}.Vera")
    assert json.loads(stored)["name"] == "Vera"


# ---------------------------------------------------------------------------
# Finding 2 — wod_check DoS guard
# ---------------------------------------------------------------------------


async def test_wod_check_huge_pool_returns_fast_and_bounded():
    services, ctx = _build()
    dice_tools = DiceTools(services)

    seed_dice(4)
    start = time.perf_counter()
    result = await dice_tools.wod_check(ctx, pool_size=20_000_000, difficulty=6)
    elapsed = time.perf_counter() - start

    i18n = services.i18n.with_locale(ctx.locale)
    assert result == i18n.t(
        "kp_tools.dice.wod.out_of_range",
        max_pool=_MAX_WOD_POOL,
        min_difficulty=2,
        max_difficulty=10,
    )
    assert elapsed < 1.0


async def test_wod_check_bad_difficulty_is_rejected():
    services, ctx = _build()
    dice_tools = DiceTools(services)

    result = await dice_tools.wod_check(ctx, pool_size=5, difficulty=99)

    i18n = services.i18n.with_locale(ctx.locale)
    assert result == i18n.t(
        "kp_tools.dice.wod.out_of_range",
        max_pool=_MAX_WOD_POOL,
        min_difficulty=2,
        max_difficulty=10,
    )


async def test_wod_check_valid_input_still_rolls():
    services, ctx = _build()
    dice_tools = DiceTools(services)

    seed_dice(4)
    result = await dice_tools.wod_check(ctx, pool_size=5, difficulty=6)

    assert "WoD" in result
    assert "5d10" in result
